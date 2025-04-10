import React, { useEffect, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';

function ConnectWalletApp() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [error, setError] = useState(null);

  // Extract query params
  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('userId');
  const session = urlParams.get('session');

  // Debugging logs
  useEffect(() => {
    console.log('Privy ready:', ready);
    console.log('Authenticated:', authenticated);
    console.log('Wallets:', wallets);
    if (ready && authenticated && wallets.length > 0) {
      handleWalletConnect();
    }
  }, [ready, authenticated, wallets]);

  const handleWalletConnect = async () => {
    try {
      const wallet = wallets[0];
      const walletAddress = wallet.address;
      console.log('Connecting wallet:', walletAddress);

      await axios.post(`${process.env.WEBAPP_URL || 'https://directpay.onrender.com'}/webhook/wallet-connected`, {
        userId,
        walletAddress,
      });
      console.log('Wallet connected successfully');
    } catch (err) {
      setError('Failed to connect wallet. Try again.');
      console.error('Wallet connect error:', err);
    }
  };

  // Render loading state
  if (!ready) {
    return <div>Loading Privy...</div>;
  }

  // Render based on authentication state
  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>Connect Your Wallet</h1>
      {authenticated ? (
        <>
          <p>Connected: {wallets[0]?.address}</p>
          <button onClick={logout} style={{ padding: '10px', margin: '5px' }}>
            Disconnect
          </button>
        </>
      ) : (
        <button onClick={login} style={{ padding: '10px', margin: '5px' }}>
          Connect Wallet
        </button>
      )}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <p>User ID: {userId || 'Not provided'}</p> {/* Debugging */}
      <p>Session: {session || 'Not provided'}</p> {/* Debugging */}
    </div>
  );
}

export default ConnectWalletApp;
