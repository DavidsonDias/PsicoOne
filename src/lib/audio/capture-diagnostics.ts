/** Web Audio capture does not require the browser's optional SpeechRecognition API. */
export function captureSupportError(): string | null {
  if (!window.isSecureContext) return "Abra o PsicoOne em HTTPS para usar o microfone.";
  if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || (window as any).webkitAudioContext)) {
    return "Este navegador não oferece captura de áudio. Abra o PsicoOne no Chrome, Edge, Firefox ou Safari atualizado.";
  }
  return null;
}

export function captureErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microfone bloqueado. Permita o microfone nas configurações deste site e do sistema e tente novamente.";
  if (name === "NotFoundError") return "Nenhum microfone encontrado. Conecte um microfone e tente novamente.";
  if (name === "NotReadableError") return "O microfone está indisponível. Feche outros aplicativos que estejam usando o dispositivo e tente novamente.";
  return "Não foi possível iniciar a captura de áudio. Verifique o microfone e tente novamente.";
}
