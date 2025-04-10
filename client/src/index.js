import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import ConnectWalletApp from './ConnectWalletApp';

if (!process.env.REACT_APP_PRIVY_APP_ID) {
  console.error('REACT_APP_PRIVY_APP_ID is not set in environment');
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <PrivyProvider appId={process.env.REACT_APP_PRIVY_APP_ID}>
    <ConnectWalletApp />
  </PrivyProvider>
);
