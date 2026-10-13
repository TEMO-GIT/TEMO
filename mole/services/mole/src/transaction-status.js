// Inclusion permits subsequent submissions; only finality permits final outcome reporting.
export const transactionFinal = entry => ['confirmed', 'reverted'].includes(entry?.status);
export const transactionIncluded = entry => entry?.status === 'confirmed' ||
  (entry?.status === 'mined' && entry.receipt?.status === 'success');
