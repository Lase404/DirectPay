import React, { useEffect, useState } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { ethers } from 'ethers';
import { useSearchParams } from 'react-router-dom';

function ConnectWalletApp() {
  return (
    <PrivyProvider
      appId={process.env.PRIVY_APP_ID} // Set this in your .env
      config={{
        loginMethods: ['wallet', 'email', 'sms'],
        appearance: {
          theme: 'light',
          accentColor: '#5288F0',
          logo: 'https://your-logo-url.com/logo.png' // Optional: Add your bot’s logo
        }
      }}
    >
      <ConnectWallet />
    </PrivyProvider>
  );
}

function ConnectWallet() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [searchParams] = useSearchParams();
  const userId = searchParams.get('userId');
  const session = searchParams.get('session'); // Optional: for session validation
  const [status, setStatus] = useState('Connecting wallet...');

  // Trigger Privy login UI when component loads and user isn’t authenticated
  useEffect(() => {
    if (ready && !authenticated) {
      login(); // Opens Privy’s wallet connection UI
    }
  }, [ready, authenticated, login]);

  // Handle wallet connection and signing once authenticated
  useEffect(() => {
    if (ready && authenticated && wallets.length > 0) {
      handleWalletConnected();
    }
  }, [ready, authenticated, wallets]);

  const handleWalletConnected = async () => {
    const wallet = wallets[0]; // Use the first connected wallet
    const provider = await wallet.getEthereumProvider();
    const ethersProvider = new ethers.providers.Web3Provider(provider);
    const signer = ethersProvider.getSigner();
    const walletAddress = wallet.address;

    try {
      setStatus('Wallet connected! Fetching transaction details...');

      // Notify backend of wallet connection
      await axios.post('https://directpay.onrender.com/webhook/wallet-connected', {
        userId,
        walletAddress
      });

      // Fetch session data from backend
      const { data: sessionData } = await axios.get(`https://directpay.onrender.com/api/session?userId=${userId}`);
      if (!sessionData) throw new Error('No session data found');
      const { amountInWei: amount, token, walletAddress: blockradarWallet } = sessionData;

      // Ensure wallet is on the correct chain
      const currentChainId = parseInt(await wallet.getChainId(), 16); // Convert hex to decimal
      if (currentChainId !== token.chainId) {
        setStatus(`Switching to chain ${token.chainId}...`);
        await wallet.switchChain(token.chainId);
      }

      // Get Relay quote
      setStatus('Fetching quote from Relay...');
      const quoteResponse = await axios.post('https://api.relay.link/quote/v1', {
        user: walletAddress,
        originChainId: token.chainId,
        originCurrency: token.address,
        destinationChainId: 8453,
        destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        recipient: blockradarWallet,
        amount: amount,
        refundTo: walletAddress
      });
      const quote = quoteResponse.data;

      const depositStep = quote.steps.find(step => step.id === 'deposit');
      if (!depositStep) throw new Error('No deposit step in quote');
      const txData = depositStep.items[0].data;

      // Step 1: Approve token if not native (triggers wallet popup)
      if (token.address !== '0x0000000000000000000000000000000000000000') {
        setStatus('Please approve the token spend in your wallet...');
        const tokenContract = new ethers.Contract(
          token.address,
          ['function approve(address spender, uint256 amount) returns (bool)'],
          signer
        );
        const approveTx = await tokenContract.approve(txData.to, amount);
        setStatus('Waiting for approval confirmation...');
        const approveReceipt = await approveTx.wait();
        console.log('Approval successful:', approveReceipt.transactionHash);
      } else {
        setStatus('No approval needed for native token.');
      }

      // Step 2: Sign and send deposit transaction (triggers wallet popup)
      setStatus('Please confirm the deposit transaction in your wallet...');
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
      const depositReceipt = await txResponse.wait();
      console.log('Deposit successful:', depositReceipt.transactionHash);

      // Notify backend of deposit
      await axios.post('https://directpay.onrender.com/webhook/deposit-signed', {
        userId,
        txHash: depositReceipt.transactionHash
      });

      setStatus('Deposit completed! Return to Telegram to check your payout status.');
      alert('Deposit completed! Return to Telegram to check your payout status.');
      logout(); // Optional: Reset for next use
    } catch (error) {
      console.error('Error in wallet connection or signing:', error);
      setStatus(`Error: ${error.message || 'Something went wrong.'}`);
      alert(`Error: ${error.message || 'Something went wrong. Try again or check Telegram.'}`);
    }
  };

  // Simple UI with status updates
  return (
    <div style={{ textAlign: 'center', padding: '20px' }}>
      <h1>Connect Your Wallet</h1>
      <p>{status}</p>
      {ready && authenticated && wallets.length > 0 && (
        <p>Follow the prompts in your wallet to approve and deposit.</p>
      )}
    </div>
  );
}

export default ConnectWalletApp;
