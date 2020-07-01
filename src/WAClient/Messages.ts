import WhatsAppWebBase from './Base'
import fetch from 'node-fetch'
import {
    MessageOptions,
    MessageType,
    Mimetype,
    MimetypeMap,
    MediaPathMap,
    WALocationMessage,
    WAContactMessage,
    WASendMessageResponse,
    Presence,
} from './Constants'
import { generateMessageID, sha256, hmacSign, aesEncrypWithIV, randomBytes } from '../WAConnection/Utils'
import { WAMessageContent, WAMetric, WAFlag } from '../WAConnection/Constants'
import { generateThumbnail, getMediaKeys } from './Utils'

export default class WhatsAppWebMessages extends WhatsAppWebBase {
    /**
     * Send a read receipt to the given ID for a certain message
     * @param {string} jid the ID of the person/group whose message you want to mark read
     * @param {string} messageID the message ID
     */
    sendReadReceipt(jid: string, messageID: string) {
        const json = [
            'action',
            { epoch: this.msgCount.toString(), type: 'set' },
            [['read', { count: '1', index: messageID, jid: jid, owner: 'false' }, null]],
        ]
        return this.queryExpecting200(json, [WAMetric.group, WAFlag.ignore]) // encrypt and send  off
    }
    /**
     * Tell someone about your presence -- online, typing, offline etc.
     * @param jid the ID of the person/group who you are updating
     * @param type your presence
     */
    async updatePresence(jid: string, type: Presence) {
        const json = [
            'action',
            { epoch: this.msgCount.toString(), type: 'set' },
            [['presence', { type: type, to: jid }, null]],
        ]
        return this.queryExpecting200(json, [WAMetric.group, WAFlag.acknowledge]) as Promise<{ status: number }>
    }
    async sendMessage(
        id: string,
        message: string | WALocationMessage | WAContactMessage | Buffer,
        type: MessageType,
        options: MessageOptions = {},
    ) {
        let m: any = {}
        switch (type) {
            case MessageType.text:
            case MessageType.extendedText:
                if (typeof message !== 'string') {
                    throw 'expected message to be a string'
                }
                m.extendedTextMessage = { text: message }
                break
            case MessageType.location:
            case MessageType.liveLocation:
                m.locationMessage = message as WALocationMessage
                break
            case MessageType.contact:
                m.contactMessage = message as WAContactMessage
                break
            default:
                m = await this.prepareMediaMessage(message as Buffer, type, options)
                break
        }
        return this.sendGenericMessage(id, m as WAMessageContent, options)
    }
    /** Prepare a media message for sending */
    protected async prepareMediaMessage(buffer: Buffer, mediaType: MessageType, options: MessageOptions = {}) {
        if (mediaType === MessageType.document && !options.mimetype) {
            throw 'mimetype required to send a document'
        }
        if (mediaType === MessageType.sticker && options.caption) {
            throw 'cannot send a caption with a sticker'
        }
        if (!options.mimetype) {
            options.mimetype = MimetypeMap[mediaType]
        }
        let isGIF = false
        if (options.mimetype === Mimetype.gif) {
            isGIF = true
            options.mimetype = MimetypeMap[MessageType.video]
        }
        // generate a media key
        const mediaKey = randomBytes(32)
        const mediaKeys = getMediaKeys(mediaKey, mediaType)
        const enc = aesEncrypWithIV(buffer, mediaKeys.cipherKey, mediaKeys.iv)
        const mac = hmacSign(Buffer.concat([mediaKeys.iv, enc]), mediaKeys.macKey).slice(0, 10)
        const body = Buffer.concat([enc, mac]) // body is enc + mac
        const fileSha256 = sha256(buffer)
        // url safe Base64 encode the SHA256 hash of the body
        const fileEncSha256B64 = sha256(body)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/\=+$/, '')

        await generateThumbnail(buffer, mediaType, options)
        // send a query JSON to obtain the url & auth token to upload our media
        const json = (await this.query(['query', 'mediaConn'])).media_conn
        const auth = json.auth // the auth token
        let hostname = 'https://' + json.hosts[0].hostname // first hostname available
        hostname += MediaPathMap[mediaType] + '/' + fileEncSha256B64 // append path
        hostname += '?auth=' + auth // add auth token
        hostname += '&token=' + fileEncSha256B64 // file hash

        const urlFetch = await fetch(hostname, {
            method: 'POST',
            body: body,
            headers: { Origin: 'https://web.whatsapp.com' },
        })
        const responseJSON = await urlFetch.json()
        if (!responseJSON.url) {
            throw 'UPLOAD FAILED GOT: ' + JSON.stringify(responseJSON)
        }
        const message = {}
        message[mediaType] = {
            url: responseJSON.url,
            mediaKey: mediaKey.toString('base64'),
            mimetype: options.mimetype,
            fileEncSha256: fileEncSha256B64,
            fileSha256: fileSha256.toString('base64'),
            fileLength: buffer.length,
            gifPlayback: isGIF || null,
        }
        return message
    }
    /** Generic send message function */
    async sendGenericMessage(id: string, message: WAMessageContent, options: MessageOptions) {
        if (!options.timestamp) {
            // if no timestamp was provided,
            options.timestamp = new Date() // set timestamp to now
        }
        const key = Object.keys(message)[0]
        const timestamp = options.timestamp.getTime() / 1000
        const quoted = options.quoted
        if (quoted) {
            const participant = quoted.key.participant || quoted.key.remoteJid
            message[key].contextInfo = {
                participant: participant,
                stanzaId: quoted.key.id,
                quotedMessage: quoted.message,
            }
            // if a participant is quoted, then it must be a group
            // hence, remoteJid of group must also be entered
            if (quoted.key.participant) {
                message[key].contextInfo.remoteJid = quoted.key.remoteJid
            }
        }
        message[key].caption = options?.caption
        message[key].jpegThumbnail = options?.thumbnail

        const messageJSON = {
            key: {
                remoteJid: id,
                fromMe: true,
                id: generateMessageID(),
            },
            message: message,
            messageTimestamp: timestamp,
            participant: id.includes('@g.us') ? this.userMetaData.id : null,
        }
        const json = ['action', { epoch: this.msgCount.toString(), type: 'relay' }, [['message', null, messageJSON]]]
        const response = await this.queryExpecting200(json, [WAMetric.message, WAFlag.ignore], null, messageJSON.key.id)
        return { status: response.status as number, messageID: messageJSON.key.id } as WASendMessageResponse
    }
}