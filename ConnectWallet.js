import React, { useState, useEffect } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { ethers } from 'ethers';
import './ConnectWalletApp.css'; // Optional styling

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) public view returns (uint256)',
];

const ConnectWalletApp = () => {
  return (
    <PrivyProvider
      appId={process.env.REACT_APP_PRIVY_APP_ID} // Ensure this is in .env
      config={{
        loginMethods: ['wallet', 'email'],
        appearance: {
          theme: 'light',
          accentColor: '#5288F9',
        },
      }}
    >
      <WalletConnector />
    </PrivyProvider>
  );
};

const WalletConnector = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Loading session...');
  const [userId, setUserId] = useState('');
  const [sessionId, setSessionId] = useState('');

  // Extract userId and session from URL params
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const userIdParam = urlParams.get('userId');
    const sessionParam = urlParams.get('session');
    if (userIdParam && sessionParam) {
      setUserId(userIdParam);
      setSessionId(sessionParam);
      fetchSession(userIdParam, sessionParam);
    } else {
      setError('Missing userId or session in URL');
      setStatus('');
    }
  }, []);

  // Fetch session data from bot
  const fetchSession = async (userId, session) => {
    try {
      const response = await axios.get(`${process.env.REACT_APP_API_URL}/api/session`, {
        params: { userId, session },
      });
      setSession(response.data);
      setStatus(authenticated ? 'Wallet connected, awaiting action...' : 'Please connect your wallet');
    } catch (err) {
      setError('Failed to fetch session: ' + err.message);
      setStatus('');
      notifyError(userId, 'Failed to fetch session data');
    }
  };

  // Handle wallet connection and log progress
  useEffect(() => {
    if (ready && authenticated && session && wallets.length > 0) {
      handleWalletConnection();
    }
  }, [ready, authenticated, session, wallets]);

  const handleWalletConnection = async () => {
    const wallet = wallets[0]; // Use the first connected wallet
    setStatus('Wallet connected: ' + wallet.address);
    console.log('Wallet connected:', wallet.address); // Debug log

    try {
      // Notify bot of wallet connection
      await axios.post(`${process.env.REACT_APP_API_URL}/webhook/wallet-connected`, {
        userId,
        walletAddress: wallet.address,
      });
      setStatus('Wallet connected successfully. Proceed with transaction?');

      // Pause here for user confirmation before proceeding
    } catch (err) {
      setError('Wallet connection failed: ' + err.message);
      setStatus('');
      notifyError(userId, 'Wallet connection failed: ' + err.message);
    }
  };

  // Separate transaction flow, triggered manually
  const handleTransactionFlow = async () => {
    const wallet = wallets[0];
    setStatus('Starting transaction...');
    console.log('Starting transaction flow...'); // Debug log

    try {
      const provider = await wallet.getEthersProvider();
      const network = await provider.getNetwork();
      console.log('Current network:', network.chainId); // Debug log

      if (network.chainId !== session.chainId) {
        setStatus('Switching network...');
        await wallet.switchChain(session.chainId);
        setStatus('Network switched, approving token...');
      }

      const signer = provider.getSigner();
      const tokenContract = new ethers.Contract(session.asset, ERC20_ABI, signer);
      const allowance = await tokenContract.allowance(wallet.address, session.blockradarAddress);
      const amountBN = ethers.BigNumber.from(session.amount);

      if (allowance.lt(amountBN)) {
        setStatus('Approving token...');
        const approveTx = await tokenContract.approve(session.blockradarAddress, amountBN);
        await approveTx.wait();
        await axios.post(`${process.env.REACT_APP_API_URL}/webhook/approval-confirmed`, {
          userId,
          walletAddress: wallet.address,
          txHash: approveTx.hash,
        });
        setStatus('Approval confirmed, depositing...');
      } else {
        setStatus('Allowance sufficient, depositing...');
      }

      const balance = await tokenContract.balanceOf(wallet.address);
      if (balance.lt(amountBN)) {
        throw new Error('Insufficient balance for transfer');
      }

      const transferTx = await tokenContract.transfer(session.blockradarAddress, amountBN);
      await transferTx.wait();

      await axios.post(`${process.env.REACT_APP_API_URL}/webhook/deposit-confirmed`, {
        userId,
        walletAddress: wallet.address,
        txHash: transferTx.hash,
        amount: ethers.utils.formatUnits(session.amount, session.decimals),
        chainId: session.chainId,
      });
      setStatus('Deposit confirmed! Funds are being processed.');
    } catch (err) {
      setError('Transaction failed: ' + err.message);
      setStatus('');
      notifyError(userId, 'Transaction failed: ' + err.message);
      console.error('Transaction error:', err); // Debug log
    }
  };

  const notifyError = async (userId, message) => {
    try {
      await axios.post(`${process.env.REACT_APP_API_URL}/webhook/error`, {
        userId,
        error: message,
      });
    } catch (err) {
      console.error('Failed to notify bot of error:', err);
    }
  };

  return (
    <div className="connect-wallet-container">
      <h1>DirectPay Wallet Connector</h1>
      {!ready ? (
        <p>Loading Privy...</p>
      ) : !authenticated ? (
        <div>
          <p>{status}</p>
          <button onClick={login}>Connect Wallet</button>
          {error && <p className="error">{error}</p>}
        </div>
      ) : (
        <div>
          <p>Connected Wallet: {wallets[0]?.address}</p>
          {session && (
            <div>
              <p>Token: {session.symbol} ({session.tokenName})</p>
              <p>Amount: {ethers.utils.formatUnits(session.amount, session.decimals)} {session.symbol}</p>
              <p>Network: {session.networkName}</p>
              <p>Deposit to: {session.blockradarAddress}</p>
            </div>
          )}
          <p>{status}</p>
          {error && <p className="error">{error}</p>}
          {status === 'Wallet connected successfully. Proceed with transaction?' && (
            <button onClick={handleTransactionFlow}>Proceed</button>
          )}
          <button onClick={logout}>Disconnect Wallet</button>
        </div>
      )}
    </div>
  );
};

export default ConnectWalletApp;
