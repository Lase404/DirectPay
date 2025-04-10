import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { ethers } from 'ethers';

function ConnectWalletApp() {
  const [searchParams] = new URLSearchParams(window.location.search);
  const userId = searchParams.get('userId');
  const session = searchParams.get('session'); // Optional

  return (
    <PrivyProvider
      appId={process.env.REACT_APP_PRIVY_APP_ID} // In .env
      config={{
        loginMethods: ['wallet'],
        appearance: {
          theme: 'light',
          accentColor: '#5288F0',
          logo: 'https://your-logo-url.com/logo.png' // Optional
        }
      }}
    >
      <ConnectWallet userId={userId} session={session} />
    </PrivyProvider>
  );
}

function ConnectWallet({ userId, session }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [status, setStatus] = useState('Connecting wallet...');

  useEffect(() => {
    if (ready && !authenticated) {
      login(); // Trigger Privy UI
    }
  }, [ready, authenticated, login]);

  useEffect(() => {
    if (ready && authenticated && wallets.length > 0) {
      handleWalletConnected();
    }
  }, [ready, authenticated, wallets]);

  const handleWalletConnected = async () => {
    const wallet = wallets[0];
    const provider = await wallet.getEthereumProvider();
    const ethersProvider = new ethers.providers.Web3Provider(provider);
    const signer = ethersProvider.getSigner();
    const walletAddress = wallet.address;

    try {
      setStatus('Wallet connected! Fetching details...');

      await axios.post('https://directpay.onrender.com/webhook/wallet-connected', {
        userId,
        walletAddress
      });

      const { data: sessionData } = await axios.get(`https://directpay.onrender.com/api/session?userId=${userId}`);
      if (!sessionData) throw new Error('No session data found');
      const { amountInWei: amount, token, walletAddress: blockradarWallet } = sessionData;

      const currentChainId = parseInt(await wallet.getChainId(), 16);
      if (currentChainId !== token.chainId) {
        setStatus(`Switching to chain ${token.chainId}...`);
        await wallet.switchChain(token.chainId);
      }

      setStatus('Fetching quote...');
      const quoteResponse = await axios.post('https://api.relay.link/quote/v1', {
        user: walletAddress,
        originChainId: token.chainId,
        originCurrency: token.address,
        destinationChainId: 8453,
        destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tradeType: 'EXACT_INPUT',
        recipient: blockradarWallet,
        amount: amount,
        refundTo: walletAddress
      });
      const quote = quoteResponse.data;

      const depositStep = quote.steps.find(step => step.id === 'deposit');
      if (!depositStep) throw new Error('No deposit step in quote');
      const txData = depositStep.items[0].data;

      if (token.address !== '0x0000000000000000000000000000000000000000') {
        setStatus('Please approve token spend in your wallet...');
        const tokenContract = new ethers.Contract(
          token.address,
          ['function approve(address spender, uint256 amount) returns (bool)'],
          signer
        );
        const approveTx = await tokenContract.approve(txData.to, amount);
        setStatus('Waiting for approval confirmation...');
        await approveTx.wait();
      } else {
        setStatus('No approval needed for native token.');
      }

      setStatus('Please confirm deposit in your wallet...');
      const txResponse = await signer.sendTransaction({
        from: walletAddress,
        to: txData.to,
        data: txData.data,
        value: txData.value ? ethers.BigNumber.from(txData.value) : undefined,
        chainId: txData.chainId,
        gasLimit: txData.gas ? ethers.BigNumber.from(txData.gas) : undefined,
        maxFeePerGas: txData.maxFeePerGas ? ethers.BigNumber.from(txData.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: txData.maxPriorityFeePerGas ? ethers.BigNumber.from(txData.maxPriorityFeePerGas) : undefined
      });
      setStatus('Waiting for deposit confirmation...');
      await txResponse.wait();

      await axios.post('https://directpay.onrender.com/webhook/deposit-signed', {
        userId,
        txHash: txResponse.hash
      });

      setStatus('Deposit completed! Return to Telegram.');
      alert('Deposit completed! Return to Telegram to check status.');
      logout();
    } catch (error) {
      console.error('Error:', error);
      setStatus(`Error: ${error.message || 'Something went wrong.'}`);
      alert(`Error: ${error.message || 'Try again or check Telegram.'}`);
    }
  };

  return (
    <div style={{ textAlign: 'center', padding: '20px' }}>
      <h1>Connect Your Wallet</h1>
      <p>{status}</p>
    </div>
  );
}

// Render the app
const root = createRoot(document.getElementById('root'));
root.render(<ConnectWalletApp />);
