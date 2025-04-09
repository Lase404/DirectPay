import React, { useEffect } from 'react';
import { PrivyProvider, usePrivy, useConnectWallet } from '@privy-io/react-auth';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';

function ConnectWalletApp() {
  return (
    <PrivyProvider appId={process.env.PRIVY_APP_ID}>
      <ConnectWallet />
    </PrivyProvider>
  );
}

function ConnectWallet() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { connectWallet } = useConnectWallet();
  const [searchParams] = useSearchParams();
  const userId = searchParams.get('userId');

  useEffect(() => {
    if (ready && !authenticated) {
      connectWallet();
    }
    if (ready && authenticated) {
      handleWalletConnected();
    }
  }, [ready, authenticated]);

  const handleWalletConnected = async () => {
    const accessToken = await getAccessToken();
    const walletAddress = window.ethereum?.selectedAddress; // Assuming EIP-6963 provider
    await axios.post('https://yourdomain.com/webhook/wallet-connected', {
      userId,
      walletAddress,
      accessToken
    });
    alert('Wallet connected! Return to Telegram to proceed.');
  };

  return (
    <div>
      <h1>Connect Your Wallet</h1>
      <button onClick={connectWallet} disabled={!ready || authenticated}>
        Connect Wallet
      </button>
    </div>
  );
}

export default ConnectWalletApp;
