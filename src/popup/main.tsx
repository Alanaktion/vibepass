import { PasskeyVerification } from './PasskeyVerification';
import { render } from 'preact';
import { App } from './App';
import { startPopupSession } from './session';

const verification = new URLSearchParams(location.search).get('verify');
if (!verification) startPopupSession();
const root = document.getElementById('app');
if (root) render(verification ? <PasskeyVerification id={verification} /> : <App />, root);
