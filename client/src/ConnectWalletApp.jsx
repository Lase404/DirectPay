import React, { useEffect, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';

function ConnectWalletApp() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [error, setError] = useState(null);

  // Extract userId and session from URL query params
  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('userId');
  const session = urlParams.get('session');

  useEffect(() => {
    if (ready && authenticated && wallets.length > 0) {
      handleWalletConnect();
    }
  }, [ready, authenticated, wallets]);

  const handleWalletConnect = async () => {
    try {
      const wallet = wallets[0]; // Use the first connected wallet
      const walletAddress = wallet.address;

      // Notify backend of wallet connection
      await axios.post(`${process.env.WEBAPP_URL}/webhook/wallet-connected`, {
        userId,
        walletAddress,
      });

      // Here you’d add Relay SDK logic if needed (e.g., sign transaction)
      console.log('Wallet connected:', walletAddress);
    } catch (err) {
      setError('Failed to connect wallet. Try again.');
      console.error(err);
    }
  };

  if (!ready) {
    return <div>Loading...</div>;
  }

  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>Connect Your Wallet</h1>
      {!authenticated ? (
        <button onClick={login}>Connect Wallet</button>
      ) : (
        <>
          <p>Connected: {wallets[0]?.address}</p>
          <button onClick={logout}>Disconnect</button>
        </>
      )}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}

export default ConnectWalletApp;
