corepack yarn pbjs -t static-module -w commonjs -o ./WAProto/index.js ./WAProto/WAProto.proto;
corepack yarn pbts -o ./WAProto/index.d.ts ./WAProto/index.js;