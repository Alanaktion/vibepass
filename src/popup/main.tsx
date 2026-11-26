import { render } from 'preact';
import { App } from './App';
import { startPopupSession } from './session';

startPopupSession();
const root = document.getElementById('app');
if (root) render(<App />, root);
