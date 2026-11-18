const encoder = new TextEncoder();
const ITERATIONS = 600000;
const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function deriveKey(password, salt, usage) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material,
    { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

export async function encryptApiKey(apiKey, password, endpoint) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('解锁口令至少需要 8 个字符。');
  if (!apiKey?.trim()) throw new Error('请输入 API_KEY。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(endpoint) }, key, encoder.encode(apiKey.trim()));
  return { version: 1, iterations: ITERATIONS, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext), endpoint };
}

export async function decryptApiKey(vault, password, endpoint) {
  if (!vault || vault.version !== 1 || vault.iterations !== ITERATIONS || vault.endpoint !== endpoint) {
    throw new Error('密钥与当前服务地址不匹配，请重新保存 API_KEY。');
  }
  try {
    const key = await deriveKey(password, decode(vault.salt), 'decrypt');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(vault.iv), additionalData: encoder.encode(endpoint) }, key, decode(vault.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('解锁失败：口令不正确或密钥数据已损坏。');
  }
}
