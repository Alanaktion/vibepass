import { useEffect, useState } from 'preact/hooks';

/** Whether this browser and device can unlock Vibepass with Touch ID or Windows Hello. */
export interface BiometricSupport {
  available: boolean;
  /** What to call it here: "Touch ID", "Windows Hello", or "biometrics". */
  label: string;
}

function platformLabel(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform ?? navigator.platform).toLowerCase();
  if (platform.includes('mac')) return 'Touch ID';
  if (platform.includes('win')) return 'Windows Hello';
  return 'biometrics';
}

/**
 * Needs a platform authenticator that does the WebAuthn PRF extension, from an extension page.
 * Firefox doesn't yet let an extension use its own origin for WebAuthn (bug 1693562), so it's
 * off there until that ships.
 */
export async function biometricSupport(): Promise<BiometricSupport> {
  const label = platformLabel();
  const no = { available: false, label };
  if (__BROWSER__ === 'firefox' || typeof PublicKeyCredential === 'undefined') return no;
  try {
    if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return no;
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = (await PublicKeyCredential.getClientCapabilities()) as Record<
        string,
        boolean | undefined
      >;
      if (caps['extension:prf'] === false) return no;
    }
    return { available: true, label };
  } catch {
    return no;
  }
}

/** The support check, as a hook; unavailable until the check answers. */
export function useBiometricSupport(): BiometricSupport {
  const [support, setSupport] = useState<BiometricSupport>({ available: false, label: '' });
  useEffect(() => {
    let live = true;
    void biometricSupport().then((s) => {
      if (live) setSupport(s);
    });
    return () => {
      live = false;
    };
  }, []);
  return support;
}
