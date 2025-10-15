/**
 * ID Generation Utilities for StackCast Prediction Markets
 *
 * Generalized deterministic ID generation using SHA-256 hashing.
 * All IDs are cryptographically derived from their input data.
 */

import { sha256 } from '@noble/hashes/sha256';

/**
 * Generate a deterministic ID from a type prefix and input components
 *
 * @param type - The type/namespace of the ID (e.g., 'question', 'market', 'order')
 * @param components - Array of string components to include in the hash
 * @returns 32-byte buffer
 *
 * @example
 * // Question ID
 * generateId('question', [questionText, creator])
 *
 * // Market ID
 * generateId('market', [questionText, oracle])
 *
 * // Order ID
 * generateId('order', [maker, taker, positionId, amount.toString(), timestamp.toString()])
 */
export function generateId(type: string, components: string[]): Buffer {
  const data = `${type}:${components.join(':')}`;
  const encoder = new TextEncoder();
  const hash = sha256(encoder.encode(data));
  return Buffer.from(hash);
}

/**
 * Generate a composite ID by hashing multiple buffers together
 * Used for more complex ID generation like condition IDs
 *
 * @param parts - Array of buffers or strings to concatenate and hash
 * @returns 32-byte buffer
 *
 * @example
 * // Condition ID: hash(oracle + questionId + outcomeCount)
 * generateCompositeId([
 *   Buffer.from(oracleAddress),
 *   questionIdBuffer,
 *   Buffer.from(outcomeCount.toString())
 * ])
 */
export function generateCompositeId(parts: (Buffer | string | number)[]): Buffer {
  const encoder = new TextEncoder();

  // Convert all parts to Uint8Array
  const converted = parts.map(part => {
    if (Buffer.isBuffer(part)) {
      return new Uint8Array(part);
    } else if (typeof part === 'string') {
      return encoder.encode(part);
    } else if (typeof part === 'number') {
      return encoder.encode(part.toString());
    } else {
      throw new Error('Invalid part type, must be Buffer, string, or number');
    }
  });

  // Calculate total length
  const totalLength = converted.reduce((sum, bytes) => sum + bytes.length, 0);

  // Concatenate all parts
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const bytes of converted) {
    combined.set(bytes, offset);
    offset += bytes.length;
  }

  const hash = sha256(combined);
  return Buffer.from(hash);
}

/**
 * Helper to convert buffer to hex string
 */
export function toHex(buffer: Buffer): string {
  return '0x' + buffer.toString('hex');
}

/**
 * Helper to convert hex string to buffer (handles 0x prefix)
 */
export function fromHex(hex: string): Buffer {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(cleaned, 'hex');
}
