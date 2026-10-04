/** SHA-256 of text, hex. Web Crypto, available in Node 24 and every runtime T3 Fleet targets. */
export const sha256 = async (text: string | Uint8Array) => {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
