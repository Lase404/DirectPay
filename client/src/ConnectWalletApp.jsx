import React, { useEffect, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { RelayClient } from '@reservoir0x/relay-sdk';

function ConnectWalletApp() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);

  const relayClient = new RelayClient({
    baseUrl: 'https://api.relay.link',
  });

  // Extract params from URL
  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('userId');
  const session = urlParams.get('session');

  useEffect(() => {
    if (ready && authenticated && wallets.length > 0 && !status) {
      initiateApprovalAndDeposit();
    }
  }, [ready, authenticated, wallets]);

  const initiateApprovalAndDeposit = async () => {
    try {
      const wallet = wallets[0];
      const walletAddress = wallet.address;

      // Notify backend of wallet connection
      await axios.post(`${process.env.WEBAPP_URL || 'https://directpay.onrender.com'}/webhook/wallet-connected`, {
        userId,
        walletAddress,
      });

      // Fetch sell details from backend (assumes session links to sellScene data)
      setStatus('Fetching transaction details...');
      const { data } = await axios.get(`${process.env.WEBAPP_URL || 'https://directpay.onrender.com'}/api/session`, {
        params: { userId, session },
      });
      const { amount, asset, chainId } = data; // Expecting amount (wei), asset (token address), chainId

      // Step 1: Approve token
      setStatus('Requesting approval...');
      const approvalTx = await relayClient.actions.approve({
        chainId,
        walletAddress,
        currency: asset,
        amount,
        walletClient: wallet,
      });
      setStatus('Waiting for approval...');
      const approvalReceipt = await approvalTx.wait();

      // Notify backend of approval
      await axios.post(`${process.env.WEBAPP_URL || 'https://directpay.onrender.com'}/webhook/approval-confirmed`, {
        userId,
        walletAddress,
        txHash: approvalReceipt.transactionHash,
      });

      // Step 2: Deposit (swap to USDC on Base)
      setStatus('Initiating deposit...');
      const depositTx = await relayClient.actions.deposit({
        chainId,
        toChainId: 8453, // Base
        walletAddress,
        currency: asset,
        toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        amount,
        walletClient: wallet,
      });
      setStatus('Waiting for deposit...');
      const depositReceipt = await depositTx.wait();

      // Notify backend of deposit completion
      await axios.post(`${process.env.WEBAPP_URL || 'https://directpay.onrender.com'}/webhook/deposit-confirmed`, {
        userId,
        walletAddress,
        txHash: depositReceipt.transactionHash,
        amount,
        chainId,
      });

      setStatus('Deposit complete!');
    } catch (err) {
      setError(`Error: ${err.message}`);
      console.error('Transaction error:', err);
      await axios.post(`${process.env.REACT_WEBAPP_URL || 'https://directpay.onrender.com'}/webhook/error`, {
        userId,
        error: err.message,
      });
    }
  };

  if (!ready) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h1>Loading...</h1>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>DirectPay Wallet</h1>
      {authenticated ? (
        <>
          <p>Wallet: {wallets[0]?.address}</p>
          <p>Status: {status || 'Connected'}</p>
          {error && <p style={{ color: 'red' }}>{error}</p>}
          <button onClick={logout} style={{ padding: '10px', margin: '5px' }}>
            Disconnect
          </button>
        </>
      ) : (
        <button onClick={login} style={{ padding: '10px', margin: '5px' }}>
          Connect Wallet
        </button>
      )}
    </div>
  );
}

export default ConnectWalletApp;
