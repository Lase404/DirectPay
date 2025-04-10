import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import ConnectWalletApp from './ConnectWalletApp';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <PrivyProvider appId={process.env.PRIVY_APP_ID}>
    <ConnectWalletApp />
  </PrivyProvider>
);
