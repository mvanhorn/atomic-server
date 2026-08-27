import { describe, it } from 'vitest';
import {
  decodeError,
  decodeSyncPush,
  encodeSyncPush,
  ErrorCode,
  SyncPushFlags,
  Tag,
} from './ws-v2.js';

function frame(requestId: number, code: number, message: string): Uint8Array {
  const messageBytes = new TextEncoder().encode(message);
  const buf = new Uint8Array(5 + messageBytes.length);
  buf[0] = Tag.ERROR;
  buf[1] = (requestId >> 8) & 0xff;
  buf[2] = requestId & 0xff;
  buf[3] = (code >> 8) & 0xff;
  buf[4] = code & 0xff;
  buf.set(messageBytes, 5);

  return buf;
}

describe('decodeError (F5: planning/unified-sync.md)', () => {
  it('decodes requestId, code, and message', ({ expect }) => {
    const encoded = frame(42, ErrorCode.UNAUTHORIZED_WRITE, 'No write right');
    // decodeError receives the payload AFTER the tag byte, matching how
    // `handleBinary` slices frames in websockets.ts.
    const decoded = decodeError(encoded.subarray(1));

    expect(decoded).toEqual({
      requestId: 42,
      code: ErrorCode.UNAUTHORIZED_WRITE,
      message: 'No write right',
    });
  });

  it('decodes an UNKNOWN code the same way as any other', ({ expect }) => {
    const encoded = frame(1, ErrorCode.UNKNOWN, 'Invalid GET frame');
    const decoded = decodeError(encoded.subarray(1));

    expect(decoded?.code).toBe(ErrorCode.UNKNOWN);
    expect(decoded?.message).toBe('Invalid GET frame');
  });

  it('returns undefined for a too-short payload', ({ expect }) => {
    // Below the [requestId: u16][code: u16] minimum (4 bytes).
    expect(decodeError(new Uint8Array([0, 1, 0]))).toBeUndefined();
  });
});

describe('SYNC_PUSH lastCommit trailer', () => {
  it('round-trips lastCommit next to each snapshot', ({ expect }) => {
    const frame = encodeSyncPush(
      'did:ad:drive',
      [
        {
          subject: 'did:ad:a',
          loroBytes: new Uint8Array([1, 2, 3]),
          lastCommit: 'did:ad:commit:abc',
        },
        {
          subject: 'did:ad:b',
          loroBytes: new Uint8Array([4, 5]),
          lastCommit: 'did:ad:commit:def',
        },
      ],
      true,
    );
    expect(frame[0]).toBe(Tag.SYNC_PUSH);
    const decoded = decodeSyncPush(frame.subarray(1));
    expect(decoded).toEqual({
      drive: 'did:ad:drive',
      last: true,
      entries: [
        {
          subject: 'did:ad:a',
          loroBytes: new Uint8Array([1, 2, 3]),
          lastCommit: 'did:ad:commit:abc',
        },
        {
          subject: 'did:ad:b',
          loroBytes: new Uint8Array([4, 5]),
          lastCommit: 'did:ad:commit:def',
        },
      ],
    });
  });

  it('still decodes a frame without the HAS_COMMIT_ID flag', ({ expect }) => {
    // Encode with ids, then clear the HAS_COMMIT_ID bit so the trailer is
    // ignored — old peers that never set the flag keep working.
    const frame = encodeSyncPush(
      'did:ad:drive',
      [
        {
          subject: 'did:ad:a',
          loroBytes: new Uint8Array([9]),
          lastCommit: 'did:ad:commit:should-be-ignored',
        },
      ],
      true,
    );
    const driveLen = (frame[1] << 8) | frame[2];
    const flagsOff = 1 + 2 + driveLen;
    frame[flagsOff] &= ~SyncPushFlags.HAS_COMMIT_ID;
    const decoded = decodeSyncPush(frame.subarray(1));
    expect(decoded?.entries[0].lastCommit).toBeUndefined();
    expect(decoded?.entries[0].subject).toBe('did:ad:a');
    expect(Array.from(decoded!.entries[0].loroBytes)).toEqual([9]);
  });
});
