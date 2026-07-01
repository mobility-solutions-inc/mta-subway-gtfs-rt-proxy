import { toBigInt as protobufJsLongToBigInt } from 'longfn'

import type { ProtobufLong } from './types.js'

export const protobufLongToBigInt = (value: ProtobufLong): bigint => {
	if (typeof value === 'bigint') return value
	if (typeof value === 'number') return BigInt(Math.trunc(value))
	return protobufJsLongToBigInt(value)
}

export const protobufLongToNumber = (value: ProtobufLong): number => {
	return parseInt(protobufLongToBigInt(value).toString(), 10)
}
