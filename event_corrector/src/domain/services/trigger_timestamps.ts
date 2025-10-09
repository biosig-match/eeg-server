const ELECTRODE_TYPE_TRIG = 3;

export type TimestampUs = bigint;

export interface TriggerPayload {
  buffer: Buffer;
  startTimeMs: number;
  samplingRate: number;
}

export function parsePayloadsAndExtractTriggerTimestampsUs(
  payloads: TriggerPayload[],
): TimestampUs[] {
  const allTriggerTimestampsUs: TimestampUs[] = [];
  let previousTriggerValueAcrossPayloads: number | null = null;

  for (const payload of payloads) {
    const { buffer, startTimeMs, samplingRate } = payload;
    if (samplingRate <= 0) {
      console.error('[Corrector] Invalid sampling rate, skipping payload.', samplingRate);
      continue;
    }
    const usPerSample = 1_000_000 / samplingRate;
    const previousTriggerValueBeforePayload = previousTriggerValueAcrossPayloads;

    try {
      if (buffer.length < 4) continue; // version(1) + num_channels(1) + reserved(2)

      let offset = 0;
      const version = buffer.readUInt8(offset);
      offset += 1;
      if (version !== 0x04) {
        console.warn(`[Corrector] Unsupported payload version ${version}, skipping.`);
        continue;
      }
      const num_channels = buffer.readUInt8(offset);
      offset += 1;
      offset += 2; // Skip reserved bytes

      let triggerChannelIndex = -1;
      for (let i = 0; i < num_channels; i++) {
        offset += 8; // Skip name
        const type = buffer.readUInt8(offset);
        offset += 1;
        offset += 1; // Skip reserved
        if (type === ELECTRODE_TYPE_TRIG) {
          triggerChannelIndex = i;
        }
      }

      if (triggerChannelIndex === -1) {
        continue;
      }

      const headerSize = offset;
      const sampleSize = num_channels * 2 + 6 + 6 + num_channels;
      if (sampleSize === 0) continue;

      const samplesBuffer = buffer.slice(headerSize);
      const numSamples = Math.floor(samplesBuffer.length / sampleSize);

      let previousTriggerValue = previousTriggerValueAcrossPayloads ?? 0;
      const startTimeUs = BigInt(startTimeMs) * 1000n;
      let firstTriggerSampleValue: number | null = null;

      for (let i = 0; i < numSamples; i++) {
        const sampleOffset = i * sampleSize;
        const signalsOffset = sampleOffset + triggerChannelIndex * 2;
        const currentTriggerValue = samplesBuffer.readInt16LE(signalsOffset);
        if (firstTriggerSampleValue === null) {
          firstTriggerSampleValue = currentTriggerValue;
        }

        if (previousTriggerValue === 0 && currentTriggerValue !== 0) {
          // マイクロ秒単位のBigIntでタイムスタンプを計算する
          const timestampUs = startTimeUs + BigInt(Math.round(i * usPerSample));
          allTriggerTimestampsUs.push(timestampUs);
        }
        previousTriggerValue = currentTriggerValue;
      }

      if (
        numSamples > 0 &&
        previousTriggerValueBeforePayload !== null &&
        firstTriggerSampleValue !== null &&
        previousTriggerValueBeforePayload !== firstTriggerSampleValue
      ) {
        console.log(
          `[Corrector] Trigger state changed across object boundary: prev=${previousTriggerValueBeforePayload}, current=${firstTriggerSampleValue} (startTimeMs=${startTimeMs}).`,
        );
      }

      if (numSamples > 0) {
        const lastSampleOffset = (numSamples - 1) * sampleSize;
        const lastSignalsOffset = lastSampleOffset + triggerChannelIndex * 2;
        previousTriggerValueAcrossPayloads = samplesBuffer.readInt16LE(lastSignalsOffset);
      }
    } catch (error) {
      console.error('[Corrector] Error parsing a binary payload, skipping it.', error);
    }
  }

  allTriggerTimestampsUs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const uniqueTriggerTimestamps: TimestampUs[] = [];
  let lastTimestamp: TimestampUs | null = null;
  for (const timestamp of allTriggerTimestampsUs) {
    if (lastTimestamp === null || timestamp !== lastTimestamp) {
      uniqueTriggerTimestamps.push(timestamp);
      lastTimestamp = timestamp;
    }
  }

  if (uniqueTriggerTimestamps.length !== allTriggerTimestampsUs.length) {
    console.warn(
      `[Corrector] Deduplicated ${
        allTriggerTimestampsUs.length - uniqueTriggerTimestamps.length
      } trigger timestamps caused by overlapping samples.`,
    );
  }

  return uniqueTriggerTimestamps;
}
