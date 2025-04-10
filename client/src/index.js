import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import ConnectWalletApp from './ConnectWalletApp';

// Use environment variable or fallback (should match Render env)
const PRIVY_APP_ID = process.env.REACT_APP_PRIVY_APP_ID || '';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <PrivyProvider appId={PRIVY_APP_ID}>
    <ConnectWalletApp />
  </PrivyProvider>
);
