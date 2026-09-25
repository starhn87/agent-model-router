// A conservative local pre-screen. It prevents known shapes from being sent to Jev,
// but it is not a comprehensive privacy or prompt-injection classifier.
const SENSITIVE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|bearer|password|secret)\s*[:=]\s*\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d ()-]{8,}\d|\b[a-f0-9]{32,}\b|\.env\b)/i;
const INJECTION = /(?:ignore (?:all )?(?:previous|prior) instructions|reveal (?:your|the) (?:system|developer) prompt|send .* (?:api key|password)|execute (?:this|the) command|이전 (?:모든 )?지시(?:를|사항을) 무시)/i;

export function looksSensitive(text: string): boolean { return SENSITIVE.test(text); }
export function looksLikeInjection(text: string): boolean { return INJECTION.test(text); }
