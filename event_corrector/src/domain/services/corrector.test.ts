import { describe, expect, test } from 'bun:test';
import { parsePayloadsAndExtractTriggerTimestampsUs } from './trigger_timestamps';

function buildTriggerPayload({
  numSamples,
  triggerSampleIndices,
  numChannels = 2,
  triggerChannelIndex = 1,
}: {
  numSamples: number;
  triggerSampleIndices: number[];
  numChannels?: number;
  triggerChannelIndex?: number;
}): Buffer {
  const headerSize = 4 + numChannels * 10;
  const sampleSize = numChannels * 2 + 6 + 6 + numChannels;
  const buffer = Buffer.alloc(headerSize + numSamples * sampleSize);
  let offset = 0;

  buffer.writeUInt8(0x04, offset++); // version
  buffer.writeUInt8(numChannels, offset++); // num_channels
  buffer.writeUInt16LE(0, offset); // reserved
  offset += 2;

  for (let i = 0; i < numChannels; i++) {
    const nameBuf = Buffer.alloc(8);
    nameBuf.write(`CH${i}`);
    nameBuf.copy(buffer, offset);
    offset += 8;
    buffer.writeUInt8(i === triggerChannelIndex ? 3 : 0, offset++); // type
    buffer.writeUInt8(0, offset++); // reserved
  }

  for (let sampleIndex = 0; sampleIndex < numSamples; sampleIndex++) {
    for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
      const value =
        channelIndex === triggerChannelIndex && triggerSampleIndices.includes(sampleIndex)
          ? 1
          : 0;
      buffer.writeInt16LE(value, offset);
      offset += 2;
    }

    buffer.fill(0, offset, offset + 12); // accel + gyro placeholder
    offset += 12;
    buffer.fill(0, offset, offset + numChannels); // impedance placeholder
    offset += numChannels;
  }

  return buffer;
}

describe('parsePayloadsAndExtractTriggerTimestampsUs', () => {
  test('returns trigger timestamps in microseconds relative to start time', () => {
    const startTimeMs = 1_000;
    const samplingRate = 1_000; // 1 sample => 1 ms => 1,000 us
    const buffer = buildTriggerPayload({
      numSamples: 5,
      triggerSampleIndices: [2],
    });

    const [timestamp] = parsePayloadsAndExtractTriggerTimestampsUs([
      { buffer, startTimeMs, samplingRate },
    ]);

    const expected = BigInt(startTimeMs) * 1000n + 2_000n;
    expect(timestamp).toBe(expected);
  });

  test('handles fractional microsecond offsets and sorts combined payloads', () => {
    const firstPayload = {
      startTimeMs: 2_000,
      samplingRate: 256,
      buffer: buildTriggerPayload({
        numSamples: 8,
        triggerSampleIndices: [3],
      }),
    };
    const secondPayload = {
      startTimeMs: 1_500,
      samplingRate: 512,
      buffer: buildTriggerPayload({
        numSamples: 8,
        triggerSampleIndices: [1],
      }),
    };

    const timestamps = parsePayloadsAndExtractTriggerTimestampsUs([
      firstPayload,
      secondPayload,
    ]);

    expect(timestamps).toHaveLength(2);
    const expectedSecond =
      BigInt(secondPayload.startTimeMs) * 1000n + BigInt(Math.round(1 * (1_000_000 / 512)));
    const expectedFirst =
      BigInt(firstPayload.startTimeMs) * 1000n + BigInt(Math.round(3 * (1_000_000 / 256)));
    expect(timestamps[0]).toBe(expectedSecond);
    expect(timestamps[1]).toBe(expectedFirst);
  });
});
