
import { proto } from '../../WAProto'
import { KEY_BUNDLE_TYPE, MIN_PREKEY_COUNT } from '../Defaults'
import { BaileysEventMap, InitialReceivedChatsState, MessageReceiptType, MessageUserReceipt, SocketConfig, WACallEvent, WAMessageStubType } from '../Types'
import { debouncedTimeout, decodeMediaRetryNode, decodeMessageStanza, delay, encodeBigEndian, generateSignalPubKey, getCallStatusFromNode, getNextPreKeys, getStatusFromReceiptType, normalizeMessageContent, unixTimestampSeconds, xmppPreKey, xmppSignedPreKey } from '../Utils'
import { makeKeyedMutex, makeMutex } from '../Utils/make-mutex'
import processMessage, { cleanMessage } from '../Utils/process-message'
import { areJidsSameUser, BinaryNode, BinaryNodeAttributes, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { makeChatsSocket } from './chats'
import { extractGroupMetadata } from './groups'

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const {
		logger,
		treatCiphertextMessagesAsReal,
		retryRequestDelayMs,
		downloadHistory
	} = config
	const sock = makeChatsSocket(config)
	const {
		ev,
		authState,
		ws,
		onUnexpectedError,
		assertSessions,
		sendNode,
		relayMessage,
		sendReceipt,
		resyncMainAppState,
		emitEventsFromMap,
		uploadPreKeys,
	} = sock

	/** this mutex ensures that the notifications (receipts, messages etc.) are processed in order */
	const processingMutex = makeKeyedMutex()

	/** this mutex ensures that each retryRequest will wait for the previous one to finish */
	const retryMutex = makeMutex()

	const historyCache = new Set<string>()
	let recvChats: InitialReceivedChatsState = { }

	const appStateSyncTimeout = debouncedTimeout(
		6_000,
		() => {
			timeoutAppState().catch(err => onUnexpectedError(err, 'timing out app state'))
		}
	)

	async function timeoutAppState() {
		logger.info(
			{ recvChats: Object.keys(recvChats).length },
			'doing initial app state sync'
		)
		if(ws.readyState === ws.OPEN) {
			await resyncMainAppState(recvChats)
		}

		historyCache.clear()
		recvChats = { }
	}

	const msgRetryMap = config.msgRetryCounterMap || { }
	const callOfferData: { [id: string]: WACallEvent } = { }

	let sendActiveReceipts = false

	const sendMessageAck = async({ tag, attrs }: BinaryNode, extraAttrs: BinaryNodeAttributes = { }) => {
		const stanza: BinaryNode = {
			tag: 'ack',
			attrs: {
				id: attrs.id,
				to: attrs.from,
				class: tag,
				...extraAttrs,
			}
		}

		if(!!attrs.participant) {
			stanza.attrs.participant = attrs.participant
		}

		if(tag !== 'message' && attrs.type && !extraAttrs.type) {
			stanza.attrs.type = attrs.type
		}

		logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, 'sent ack')
		await sendNode(stanza)
	}

	const sendRetryRequest = async(node: BinaryNode) => {
		const msgId = node.attrs.id
		const retryCount = msgRetryMap[msgId] || 1
		if(retryCount >= 5) {
			logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
			delete msgRetryMap[msgId]
			return
		}

		msgRetryMap[msgId] = retryCount + 1

		const isGroup = !!node.attrs.participant
		const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds

		const deviceIdentity = proto.ADVSignedDeviceIdentity.encode(account).finish()
		await authState.keys.transaction(
			async() => {
				const { update, preKeys } = await getNextPreKeys(authState, 1)

				const [keyId] = Object.keys(preKeys)
				const key = preKeys[+keyId]

				const decFrom = node.attrs.from ? jidDecode(node.attrs.from) : undefined
				const receipt: BinaryNode = {
					tag: 'receipt',
					attrs: {
						id: msgId,
						type: 'retry',
						to: isGroup ? node.attrs.from : jidEncode(decFrom!.user, 's.whatsapp.net', decFrom!.device, 0)
					},
					content: [
						{
							tag: 'retry',
							attrs: {
								count: retryCount.toString(),
								id: node.attrs.id,
								t: node.attrs.t,
								v: '1'
							}
						},
						{
							tag: 'registration',
							attrs: { },
							content: encodeBigEndian(authState.creds.registrationId)
						}
					]
				}

				if(node.attrs.recipient) {
					receipt.attrs.recipient = node.attrs.recipient
				}

				if(node.attrs.participant) {
					receipt.attrs.participant = node.attrs.participant
				}

				if(retryCount > 1) {
					const exec = generateSignalPubKey(Buffer.from(KEY_BUNDLE_TYPE)).slice(0, 1)
					const content = receipt.content! as BinaryNode[]
					content.push({
						tag: 'keys',
						attrs: { },
						content: [
							{ tag: 'type', attrs: { }, content: exec },
							{ tag: 'identity', attrs: { }, content: identityKey.public },
							xmppPreKey(key, +keyId),
							xmppSignedPreKey(signedPreKey),
							{ tag: 'device-identity', attrs: { }, content: deviceIdentity }
						]
					})
				}

				await sendNode(receipt)

				logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')

				ev.emit('creds.update', update)
			}
		)
	}

	const processMessageLocal = async(msg: proto.IWebMessageInfo) => {
		// process message and emit events
		const newEvents = await processMessage(
			msg,
			{
				downloadHistory,
				historyCache,
				recvChats,
				creds: authState.creds,
				keyStore: authState.keys,
				logger,
				treatCiphertextMessagesAsReal
			}
		)

		// send ack for history message
		const normalizedContent = !!msg.message ? normalizeMessageContent(msg.message) : undefined
		const isAnyHistoryMsg = !!normalizedContent?.protocolMessage?.historySyncNotification
		if(isAnyHistoryMsg) {
			// we only want to sync app state once we've all the history
			// restart the app state sync timeout
			logger.debug('restarting app sync timeout')
			appStateSyncTimeout.start()

			const jid = jidEncode(jidDecode(msg.key.remoteJid!).user, 'c.us')
			await sendReceipt(jid, undefined, [msg.key.id], 'hist_sync')
		}

		return newEvents
	}

	const handleEncryptNotification = async(node: BinaryNode) => {
		const from = node.attrs.from
		if(from === S_WHATSAPP_NET) {
			const countChild = getBinaryNodeChild(node, 'count')
			const count = +countChild.attrs.value
			const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

			logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if(shouldUploadMorePreKeys) {
				await uploadPreKeys()
			}
		} else {
			const identityNode = getBinaryNodeChild(node, 'identity')
			if(identityNode) {
				logger.info({ jid: from }, 'identity changed')
				// not handling right now
				// signal will override new identity anyway
			} else {
				logger.info({ node }, 'unknown encrypt notification')
			}
		}
	}

	const processNotification = (node: BinaryNode) => {
		const result: Partial<proto.IWebMessageInfo> = { }
		const [child] = getAllBinaryNodeChildren(node)
		const nodeType = node.attrs.type

		if(nodeType === 'w:gp2') {
			switch (child?.tag) {
			case 'create':
				const metadata = extractGroupMetadata(child)

				result.messageStubType = WAMessageStubType.GROUP_CREATE
				result.messageStubParameters = [metadata.subject]
				result.key = { participant: metadata.owner }

				ev.emit('chats.upsert', [{
					id: metadata.id,
					name: metadata.subject,
					conversationTimestamp: metadata.creation,
				}])
				ev.emit('groups.upsert', [metadata])
				break
			case 'ephemeral':
			case 'not_ephemeral':
				result.message = {
					protocolMessage: {
						type: proto.ProtocolMessage.ProtocolMessageType.EPHEMERAL_SETTING,
						ephemeralExpiration: +(child.attrs.expiration || 0)
					}
				}
				break
			case 'promote':
			case 'demote':
			case 'remove':
			case 'add':
			case 'leave':
				const stubType = `GROUP_PARTICIPANT_${child.tag!.toUpperCase()}`
				result.messageStubType = WAMessageStubType[stubType]

				const participants = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid)
				if(
					participants.length === 1 &&
                        // if recv. "remove" message and sender removed themselves
                        // mark as left
                        areJidsSameUser(participants[0], node.attrs.participant) &&
                        child.tag === 'remove'
				) {
					result.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
				}

				result.messageStubParameters = participants
				break
			case 'subject':
				result.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
				result.messageStubParameters = [ child.attrs.subject ]
				break
			case 'announcement':
			case 'not_announcement':
				result.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
				result.messageStubParameters = [ (child.tag === 'announcement') ? 'on' : 'off' ]
				break
			case 'locked':
			case 'unlocked':
				result.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
				result.messageStubParameters = [ (child.tag === 'locked') ? 'on' : 'off' ]
				break

			}
		} else if(nodeType === 'mediaretry') {
			const event = decodeMediaRetryNode(node)
			ev.emit('messages.media-update', [event])
		} else if(nodeType === 'encrypt') {
			handleEncryptNotification(node)
				.catch(err => logger.error({ node, trace: err.stack }, 'error in handling encrypt notification'))
		} else if(nodeType === 'devices') {
			const devices = getBinaryNodeChildren(child, 'device')
			if(areJidsSameUser(child.attrs.jid, authState.creds!.me!.id)) {
				const deviceJids = devices.map(d => d.attrs.jid)
				logger.info({ deviceJids }, 'got my own devices')
			}
		}

		if(Object.keys(result).length) {
			return result
		}
	}

	const willSendMessageAgain = (id: string) => {
		const retryCount = msgRetryMap[id] || 0
		return retryCount < 5
	}

	const sendMessagesAgain = async(key: proto.IMessageKey, ids: string[]) => {
		const msgs = await Promise.all(
			ids.map(id => (
				config.getMessage({ ...key, id })
			))
		)

		const participant = key.participant || key.remoteJid
		await assertSessions([participant], true)

		if(isJidGroup(key.remoteJid)) {
			await authState.keys.set({ 'sender-key-memory': { [key.remoteJid]: null } })
		}

		logger.debug({ participant }, 'forced new session for retry recp')

		for(let i = 0; i < msgs.length;i++) {
			if(msgs[i]) {
				msgRetryMap[ids[i]] = (msgRetryMap[ids[i]] || 0) + 1
				await relayMessage(key.remoteJid, msgs[i], {
					messageId: ids[i],
					participant
				})
			} else {
				logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}

	const handleReceipt = async(node: BinaryNode) => {
		let shouldAck = true

		const { attrs, content } = node
		const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, authState.creds.me?.id)
		const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		const fromMe = !attrs.recipient || (attrs.type === 'retry' && isNodeFromMe)

		const ids = [attrs.id]
		if(Array.isArray(content)) {
			const items = getBinaryNodeChildren(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id))
		}

		const key: proto.IMessageKey = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}

		await processingMutex.mutex(
			remoteJid,
			async() => {
				const status = getStatusFromReceiptType(attrs.type)
				if(
					typeof status !== 'undefined' &&
					(
					// basically, we only want to know when a message from us has been delivered to/read by the other person
					// or another device of ours has read some messages
						status > proto.WebMessageInfo.WebMessageInfoStatus.DELIVERY_ACK ||
						!isNodeFromMe
					)
				) {
					if(isJidGroup(remoteJid)) {
						const updateKey: keyof MessageUserReceipt = status === proto.WebMessageInfo.WebMessageInfoStatus.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
						ev.emit(
							'message-receipt.update',
							ids.map(id => ({
								key: { ...key, id },
								receipt: {
									userJid: jidNormalizedUser(attrs.participant),
									[updateKey]: +attrs.t
								}
							}))
						)
					} else {
						ev.emit(
							'messages.update',
							ids.map(id => ({
								key: { ...key, id },
								update: { status }
							}))
						)
					}

				}

				if(attrs.type === 'retry') {
					if(willSendMessageAgain(ids[0])) {
						// correctly set who is asking for the retry
						key.participant = key.participant || attrs.from
						if(key.fromMe) {
							try {
								logger.debug({ attrs, key }, 'recv retry request')
								await sendMessagesAgain(key, ids)
							} catch(error) {
								logger.error({ key, ids, trace: error.stack }, 'error in sending message again')
								shouldAck = false
							}
						} else {
							logger.info({ attrs, key }, 'recv retry for not fromMe message')
						}
					} else {
						logger.info({ attrs, key }, 'will not send message again, as sent too many times')
					}
				}

				if(shouldAck) {
					await sendMessageAck(node)
				}
			}
		)
	}

	const handleNotification = async(node: BinaryNode) => {
		const remoteJid = node.attrs.from
		await sendMessageAck(node)
		const msg = processNotification(node)
		if(msg) {
			const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me!.id)
			msg.key = {
				remoteJid,
				fromMe,
				participant: node.attrs.participant,
				id: node.attrs.id,
				...(msg.key || {})
			}
			msg.participant = node.attrs.participant
			msg.messageTimestamp = +node.attrs.t

			const fullMsg = proto.WebMessageInfo.fromObject(msg)
			ev.emit('messages.upsert', { messages: [fullMsg], type: 'append' })
		}
	}

	const handleUpsertedMessages = async({ messages, type }: BaileysEventMap<any>['messages.upsert']) => {
		if(type === 'notify' || type === 'append') {
			const contactNameUpdates: { [_: string]: string } = { }
			for(const msg of messages) {
				const normalizedChatId = jidNormalizedUser(msg.key.remoteJid)
				if(!!msg.pushName) {
					let jid = msg.key.fromMe ? authState.creds.me!.id : (msg.key.participant || msg.key.remoteJid)
					jid = jidNormalizedUser(jid)

					contactNameUpdates[jid] = msg.pushName
					// update our pushname too
					if(msg.key.fromMe && authState.creds.me?.name !== msg.pushName) {
						ev.emit('creds.update', { me: { ...authState.creds.me!, name: msg.pushName! } })
					}
				}

				const events = await processingMutex.mutex(
					'p-' + normalizedChatId,
					() => processMessageLocal(msg)
				)
				emitEventsFromMap(events)
			}

			if(Object.keys(contactNameUpdates).length) {
				ev.emit('contacts.update', Object.keys(contactNameUpdates).map(
					id => ({ id, notify: contactNameUpdates[id] })
				))
			}
		}
	}

	// recv a message
	ws.on('CB:message', (stanza: BinaryNode) => {
		const { fullMessage: msg, category, author, decryptionTask } = decodeMessageStanza(stanza, authState)
		processingMutex.mutex(
			msg.key.remoteJid!,
			async() => {
				await sendMessageAck(stanza)
				await decryptionTask
				// message failed to decrypt
				if(msg.messageStubType === proto.WebMessageInfo.WebMessageInfoStubType.CIPHERTEXT) {
					logger.error(
						{ key: msg.key, params: msg.messageStubParameters },
						'failure in decrypting message'
					)
					retryMutex.mutex(
						async() => {
							if(ws.readyState === ws.OPEN) {
								await sendRetryRequest(stanza)
								if(retryRequestDelayMs) {
									await delay(retryRequestDelayMs)
								}
							} else {
								logger.debug({ stanza }, 'connection closed, ignoring retry req')
							}
						}
					).catch(err => logger.error({ state: ws.readyState, trace: err.stack }, 'error when retrying request'))
				} else {
					// no type in the receipt => message delivered
					let type: MessageReceiptType = undefined
					let participant = msg.key.participant
					if(category === 'peer') { // special peer message
						type = 'peer_msg'
					} else if(msg.key.fromMe) { // message was sent by us from a different device
						type = 'sender'
						// need to specially handle this case
						if(isJidUser(msg.key.remoteJid)) {
							participant = author
						}
					} else if(!sendActiveReceipts) {
						type = 'inactive'
					}

					await sendReceipt(msg.key.remoteJid!, participant, [msg.key.id!], type)
				}

				cleanMessage(msg, authState.creds.me!.id)
				ev.emit('messages.upsert', { messages: [msg], type: stanza.attrs.offline ? 'append' : 'notify' })
			}
		)
			.catch(
				error => onUnexpectedError(error, 'processing message')
			)
	})

	ws.on('CB:call', (node: BinaryNode) => {
		handleCallNode(node)
			.catch(err => logger.error({ node, trace: err.stack }, 'error when handling call node'))
	})

	async function handleCallNode(node: BinaryNode) {
		const { attrs } = node
		const [infoChild] = getAllBinaryNodeChildren(node)
		const callId = infoChild.attrs['call-id']
		const from = infoChild.attrs.from || infoChild.attrs['call-creator']
		const status = getCallStatusFromNode(infoChild)
		const call: WACallEvent = {
			chatId: attrs.from,
			from,
			id: callId,
			date: new Date(+attrs.t * 1000),
			offline: !!attrs.offline,
			status,
		}

		if(status === 'offer') {
			call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
			call.isGroup = infoChild.attrs.type === 'group'
			callOfferData[call.id] = call
		}

		// use existing call info to populate this event
		if(callOfferData[call.id]) {
			call.isVideo = callOfferData[call.id].isVideo
			call.isGroup = callOfferData[call.id].isGroup
		}

		// delete data once call has ended
		if(status === 'reject' || status === 'accept' || status === 'timeout') {
			delete callOfferData[call.id]
		}

		ev.emit('call', [call])

		await sendMessageAck(node, { type: infoChild.tag })
			.catch(
				error => onUnexpectedError(error, 'ack call')
			)
	}

	ws.on('CB:receipt', node => {
		handleReceipt(node)
			.catch(
				error => onUnexpectedError(error, 'handling receipt')
			)
	})

	ws.on('CB:notification', (node: BinaryNode) => {
		handleNotificationNode(node)
			.catch(err => logger.error({ node, trace: err.stack }, 'error when handling notification node'))
	})

	async function handleNotificationNode(node: BinaryNode) {
		handleNotification(node)
			.catch(
				error => {
					onUnexpectedError(error, 'handling notification')
				}
			)
	}

	ev.on('messages.upsert', data => {
		handleUpsertedMessages(data)
			.catch(
				error => onUnexpectedError(error, 'handling upserted messages')
			)
	})

	ev.on('call', ([ call ]) => {
		// missed call + group call notification message generation
		if(call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
			const msg: proto.IWebMessageInfo = {
				key: {
					remoteJid: call.chatId,
					id: call.id,
					fromMe: false
				},
				messageTimestamp: unixTimestampSeconds(call.date),
			}
			if(call.status === 'timeout') {
				if(call.isGroup) {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_GROUP_VIDEO : WAMessageStubType.CALL_MISSED_GROUP_VOICE
				} else {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE
				}
			} else {
				msg.message = { call: { callKey: Buffer.from(call.id) } }
			}

			const protoMsg = proto.WebMessageInfo.fromObject(msg)
			ev.emit(
				'messages.upsert',
				{ messages: [protoMsg], type: call.offline ? 'append' : 'notify' }
			)
		}
	})

	ev.on('connection.update', ({ isOnline }) => {
		if(typeof isOnline !== 'undefined') {
			sendActiveReceipts = isOnline
			logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
		}
	})

	return {
		...sock,
		processMessage: processMessageLocal,
		sendMessageAck,
		sendRetryRequest
	}
}