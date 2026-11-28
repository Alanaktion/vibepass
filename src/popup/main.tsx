import { PasskeyVerification } from './PasskeyVerification';
import { BiometricWindow } from './BiometricWindow';
import { render } from 'preact';
import { App } from './App';
import { startPopupSession } from './session';

const params = new URLSearchParams(location.search);
const verification = params.get('verify');
const biometric = params.get('biometric');
if (!verification && !biometric) startPopupSession();
const root = document.getElementById('app');
if (root) {
  render(
    verification ? (
      <PasskeyVerification id={verification} />
    ) : biometric ? (
      <BiometricWindow id={biometric} />
    ) : (
      <App />
    ),
    root,
  );
}
