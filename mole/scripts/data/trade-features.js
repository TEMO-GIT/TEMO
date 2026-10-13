// Exact feature encoding and normalization from contract commit d132bb31c6436dbb1b73298f474556d561e0508a.
export const featureNames = Object.freeze(['isBuy', 'sizeBps', 'minutesSince', 'tipGwei',
  'trades24h', 'holdMinutes', 'capsule', 'hourVolume', 'firstSeen']);
const layout = [
  ['isBuy', 0, 1], ['sizeBps', 1, 16], ['minutesSince', 17, 24], ['tipGwei', 41, 16],
  ['trades24h', 57, 16], ['holdMinutes', 73, 24], ['capsuleDays', 97, 8],
  ['hasCapsule', 105, 1], ['hourVolume', 106, 16], ['firstSeen', 122, 1],
];
export function unsigned(value, bits = 256) {
  if (!((typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'bigint' ||
      (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)))) throw new Error('Invalid unsigned integer');
  const n = BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error('Unsigned integer out of range');
  return n;
}
export const clamp = (value, bits) => Number(unsigned(value) > (1n << BigInt(bits)) - 1n
  ? (1n << BigInt(bits)) - 1n : unsigned(value));
function validate(fields, partial) {
  for (const [name, , bits] of layout) {
    if (fields[name] === null && partial) continue;
    if (bits === 1) { if (typeof fields[name] !== 'boolean') throw new Error(`Invalid boolean field: ${name}`); }
    else unsigned(fields[name], bits);
  }
}
export function packFeatureRecord(fields) {
  validate(fields, false);
  return layout.reduce((w, [name, shift, bits]) => w | (BigInt(bits === 1 ? Number(fields[name]) : fields[name]) << BigInt(shift)), 0n);
}
export function unpackFeatureRecord(record) {
  const w = unsigned(record);
  return Object.fromEntries(layout.map(([name, shift, bits]) => {
    const n = (w >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n);
    return [name, bits === 1 ? n === 1n : Number(n)];
  }));
}
export function log2x16(value) {
  let n = unsigned(value) + 1n, l = 0;
  while (n > 1n) { n >>= 1n; l++; }
  return Math.min(255, l * 16);
}
export function normalizeFeatureFields(f) {
  validate(f, true);
  const log = n => n === null ? null : log2x16(n);
  const linear = n => n === null ? null : Math.min(255, Number(n));
  const bool = n => n === null ? null : n ? 255 : 0;
  return [bool(f.isBuy), log(f.sizeBps), log(f.minutesSince), linear(f.tipGwei), linear(f.trades24h),
    log(f.holdMinutes), f.hasCapsule === null ? null : !f.hasCapsule ? 0
      : f.capsuleDays === null ? null : Math.min(255, Number(f.capsuleDays) * 32 + 31),
    log(f.hourVolume), bool(f.firstSeen)];
}
// Native currency must be currency0, as in TEMO; callers supply proven pre-swap state.
export function sizeBpsBeforeSwap({ amountSpecified, zeroForOne, sqrtPriceX96, liquidity }) {
  if (typeof amountSpecified !== 'bigint' || amountSpecified <= -(1n << 255n) || amountSpecified >= 1n << 255n ||
      typeof zeroForOne !== 'boolean') throw new Error('Invalid swap parameters');
  const sqrt = unsigned(sqrtPriceX96, 160), l = unsigned(liquidity, 128), q = 1n << 96n;
  const amount = amountSpecified < 0n ? -amountSpecified : amountSpecified;
  let guess;
  if ((amountSpecified < 0n) === zeroForOne) guess = amount;
  else if (sqrt === 0n) guess = 0n;
  else {
    const first = unsigned(amount * q / sqrt);
    guess = unsigned(first * q / sqrt);
  }
  if (l === 0n || sqrt === 0n) return 65535;
  const reserve = l * q / sqrt;
  if (reserve === 0n) return 65535;
  return clamp(unsigned(guess * 10000n) / reserve, 16);
}

// Mirror the reserve and spot conversion when ETH/WETH is currency1 in a source pool.
// This preserves source Q96 precision; it does not invent a reciprocal TEMO pool price.
export function sizeBpsForQuoteSwap(args, quoteIs0) {
  if (quoteIs0) return sizeBpsBeforeSwap(args);
  const { amountSpecified, zeroForOne } = args;
  if (typeof amountSpecified !== 'bigint' || amountSpecified <= -(1n << 255n) || amountSpecified >= 1n << 255n ||
      typeof zeroForOne !== 'boolean') throw new Error('Invalid swap parameters');
  const sqrt = unsigned(args.sqrtPriceX96, 160), l = unsigned(args.liquidity, 128), q = 1n << 96n;
  const amount = amountSpecified < 0n ? -amountSpecified : amountSpecified;
  let guess = amount;
  if ((amountSpecified < 0n) === zeroForOne) guess = unsigned(unsigned(amount * sqrt / q) * sqrt / q);
  const reserve = l * sqrt / q;
  if (reserve === 0n) return 65535;
  return clamp(unsigned(guess * 10000n) / reserve, 16);
}
