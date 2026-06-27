import { generateKey, encryptField, decryptField } from "@/lib/crypto";

describe("AES-GCM field crypto", () => {
  it("round-trips plaintext through encrypt/decrypt", async () => {
    const key = await generateKey();
    const plaintext = "200012345678";
    const { ciphertext, iv } = await encryptField(plaintext, key);
    const decrypted = await decryptField(ciphertext, iv, key);
    expect(decrypted).toBe(plaintext);
  });

  it("never leaks the plaintext into the ciphertext (NFR-3.1)", async () => {
    const key = await generateKey();
    const plaintext = "123456789V";
    const { ciphertext } = await encryptField(plaintext, key);
    expect(ciphertext).not.toContain(plaintext);
  });

  it("produces a fresh IV per encryption (non-deterministic ciphertext)", async () => {
    const key = await generateKey();
    const a = await encryptField("0712345678", key);
    const b = await encryptField("0712345678", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = await generateKey();
    const other = await generateKey();
    const { ciphertext, iv } = await encryptField("secret", key);
    await expect(decryptField(ciphertext, iv, other)).rejects.toBeDefined();
  });
});
