import React, { useEffect, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { createClient, getClient } from '@reservoir0x/relay-sdk';
import { adaptEthersSigner } from '@reservoir0x/relay-ethers-wallet-adapter';
import { ethers } from 'ethers';
import axios from 'axios';
import './ConnectWalletApp.css';

const ConnectWalletApp = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [session, setSession] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('idle');
  const [loading, setLoading] = useState(false);
  const [transactionProgress, setTransactionProgress] = useState(null);
  const [isCancelRequested, setIsCancelRequested] = useState(false);
  const location = useLocation();

  // Initialize Relay SDK
  useEffect(() => {
    createClient({
      baseApiUrl: 'https://api.relay.link',
    });
  }, []);

  // Fetch session data
  useEffect(() => {
    const fetchSession = async () => {
      const urlParams = new URLSearchParams(location.search);
      const userId = urlParams.get('userId');
      if (!userId) {
        setError('Missing userId in URL. Please return to Telegram and try again.');
        return;
      }
      try {
        setStatus('Fetching session...');
        const response = await axios.get(`/api/session?userId=${userId}`);
        if (!response.data || !response.data.blockradarWallet) {
          throw new Error('Invalid session data received.');
        }
        setSession(response.data);
        setStatus('Session loaded.');
      } catch (err) {
        setError(`Failed to fetch session: ${err.message}. Please try again or contact support.`);
        console.error('Session fetch error:', err);
        setStatus('error');
      }
    };
    if (ready && authenticated) {
      fetchSession();
    }
  }, [ready, authenticated, location.search]);

  // Fetch quote using Relay SDK
  const fetchQuote = useCallback(async (adaptedWallet) => {
    if (!session || !adaptedWallet) return;
    setLoading(true);
    setStatus('Fetching quote...');
    try {
      const quote = await getClient().actions.getQuote({
        chainId: session.chainId,
        toChainId: 8453, // Base
        currency: session.token,
        toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        amount: session.amountInWei,
        wallet: adaptedWallet,
        recipient: session.blockradarWallet,
      });
      setQuote(quote);
      setError(null);
      setStatus('Quote received.');
    } catch (err) {
      setError(`Failed to fetch quote: ${err.message}. Please try again.`);
      console.error('Quote fetch error:', err);
      setStatus('error');
    } finally {
      setLoading(false);
    }
  }, [session]);

  // Handle sell transaction
  const handleSell = async () => {
    if (!wallets.length || !session || !quote) return;

    const wallet = wallets[0];
    const provider = await wallet.getEthersProvider();
    const signer = provider.getSigner();
    const adaptedWallet = adaptEthersSigner(signer);

    setLoading(true);
    setStatus('Executing transaction...');
    setIsCancelRequested(false);

    try {
      let txHash;
      await getClient().actions.execute({
        quote,
        wallet: adaptedWallet,
        onProgress: (progress) => {
          setTransactionProgress(progress);
          if (progress.currentStep) {
            setStatus(`${progress.currentStep.action}: ${progress.currentStep.description}`);
          }
          if (progress.txHashes && progress.txHashes.length > 0) {
            txHash = progress.txHashes[0].txHash;
            setStatus(`Transaction submitted: ${txHash}`);
          }
          if (progress.error) {
            throw new Error(progress.error.message);
          }
          if (progress.refunded) {
            throw new Error('Operation failed and was refunded.');
          }
          if (isCancelRequested) {
            throw new Error('Transaction cancelled by user.');
          }
        },
      });

      if (txHash) {
        await axios.post('/webhook/sell-completed', {
          userId: new URLSearchParams(location.search).get('userId'),
          txHash: txHash,
        });
        setStatus('Sell completed successfully!');
      } else {
        throw new Error('No transaction hash found.');
      }
    } catch (err) {
      setError(`Error during sell: ${err.message}. Please try again or contact support.`);
      console.error('Sell error:', err);
      setStatus('error');
    } finally {
      setLoading(false);
      setIsCancelRequested(false);
    }
  };

  // Fix: Use an async IIFE inside useEffect to handle fetchQuote
  useEffect(() => {
    const loadQuote = async () => {
      if (wallets.length > 0 && session && !quote && ready && authenticated) {
        try {
          const provider = await wallets[0].getEthersProvider();
          const signer = await provider.getSigner();
          const adaptedWallet = adaptEthersSigner(signer);
          await fetchQuote(adaptedWallet);
        } catch (err) {
          setError(`Failed to initialize quote fetching: ${err.message}.`);
          console.error('Quote initialization error:', err);
          setStatus('error');
        }
      }
    };

    loadQuote();
  }, [wallets, session, quote, ready, authenticated, fetchQuote]);

  // Handle cancel transaction
  const handleCancel = () => {
    setIsCancelRequested(true);
    setStatus('Cancelling transaction...');
  };

  if (!ready) return <div className="loading">Loading...</div>;

  return (
    <div className="connect-wallet-app">
      <h1>DirectPay Wallet Connector</h1>
      {!authenticated ? (
        <button onClick={login}>Connect Wallet</button>
      ) : (
        <>
          <p>Connected: {wallets[0]?.address}</p>
          <p>Status: {status}</p>
          {session ? (
            <>
              <p>Amount: {ethers.utils.formatUnits(session.amountInWei, 6)} {session.token === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'Token'}</p>
              <p>Destination: {session.blockradarWallet}</p>
              {quote ? (
                <>
                  <p>Quote: {ethers.utils.formatUnits(quote.details.currencyOut.amount, 6)} USDC</p>
                  <p>Fees: {ethers.utils.formatEther(quote.fees?.gas?.amount || '0')} ETH</p>
                  <div className="button-group">
                    <button onClick={handleSell} disabled={loading}>
                      {loading ? 'Processing...' : 'Execute Sell'}
                    </button>
                    {loading && (
                      <button onClick={handleCancel} disabled={isCancelRequested}>
                        Cancel
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p>{loading ? 'Fetching quote...' : 'Waiting for quote...'}</p>
              )}
            </>
          ) : (
            <p>Fetching session...</p>
          )}
          <button onClick={logout}>Disconnect</button>
        </>
      )}
      {error && (
        <p className="error">
          {error}
          {error.includes('Missing userId') && (
            <>
              <br />
              <a href="https://t.me/yourBotUsername">Return to Telegram</a>
            </>
          )}
        </p>
      )}
      {transactionProgress && transactionProgress.currentStep && (
        <div className="progress">
          <p>Step: {transactionProgress.currentStep.action}</p>
          <p>Description: {transactionProgress.currentStep.description}</p>
        </div>
      )}
    </div>
  );
};

const App = () => (
  <PrivyProvider appId={process.env.REACT_APP_PRIVY_APP_ID} config={{}}>
    <ConnectWalletApp />
  </PrivyProvider>
);

export default App;
