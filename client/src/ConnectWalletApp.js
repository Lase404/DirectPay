import React, { useEffect, useState } from 'react';
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
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('idle');
  const [isCancelled, setIsCancelled] = useState(false);
  const location = useLocation();

  useEffect(() => {
    createClient({
      baseApiUrl: 'https://api.relay.link',
    });
  }, []);

  useEffect(() => {
    const parseSessionFromUrl = () => {
      const urlParams = new URLSearchParams(location.search);
      const userId = urlParams.get('userId');
      if (!userId) {
        setError('Missing userId in URL. Please return to Telegram and try again.');
        return;
      }

      try {
        const sessionData = {
          userId: urlParams.get('userId'),
          amountInWei: urlParams.get('amountInWei'),
          token: urlParams.get('token'),
          chainId: parseInt(urlParams.get('chainId'), 10),
          bankDetails: JSON.parse(urlParams.get('bankDetails')),
          blockradarWallet: urlParams.get('blockradarWallet'),
          status: urlParams.get('status'),
          createdAt: urlParams.get('createdAt')
        };

        // Validate session data
        const requiredFields = ['amountInWei', 'token', 'chainId', 'bankDetails', 'blockradarWallet'];
        const missingFields = requiredFields.filter(field => !sessionData[field]);
        if (missingFields.length > 0) {
          throw new Error(`Invalid session data: Missing fields - ${missingFields.join(', ')}`);
        }

        // Validate bankDetails
        const bankRequiredFields = ['bankName', 'accountNumber', 'accountName'];
        const missingBankFields = bankRequiredFields.filter(field => !(field in sessionData.bankDetails));
        if (missingBankFields.length > 0) {
          throw new Error(`Invalid bank details: Missing fields - ${missingBankFields.join(', ')}`);
        }

        setSession(sessionData);
        setError(null);
      } catch (err) {
        console.error('Error parsing session from URL:', err);
        setError(`Failed to parse session data: ${err.message}. Please return to Telegram and try again.`);
      }
    };

    if (ready && authenticated) {
      parseSessionFromUrl();
    }
  }, [ready, authenticated, location.search]);

  const fetchQuote = async (adaptedWallet) => {
    if (!session || isCancelled) return;
    setLoading(true);
    setStatus('Fetching quote...');
    try {
      console.log(`Fetching quote for wallet ${wallets[0].address}, session:`, session);
      const quote = await getClient().actions.getQuote({
        chainId: session.chainId,
        toChainId: 8453,
        currency: session.token,
        toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        amount: session.amountInWei,
        wallet: adaptedWallet,
        recipient: session.blockradarWallet,
      });
      console.log('Quote response:', quote);
      setQuote(quote);
      setError(null);
    } catch (err) {
      console.error('Error fetching quote:', err);
      setError(`Failed to fetch quote: ${err.message || 'Unknown error'}`);
      setStatus('error');
    } finally {
      setLoading(false);
    }
  };

  const handleSell = async () => {
    if (!wallets.length || !session || !quote || isCancelled) return;

    const wallet = wallets[0];
    const provider = await wallet.getEthersProvider();
    const signer = provider.getSigner();
    const adaptedWallet = adaptEthersSigner(signer);

    setLoading(true);
    setStatus('Executing transaction...');

    try {
      let txHash;
      await getClient().actions.execute({
        quote,
        wallet: adaptedWallet,
        onProgress: (progress) => {
          console.log('Transaction progress:', progress);
          if (progress.txHashes && progress.txHashes.length > 0) {
            txHash = progress.txHashes[0].txHash;
            setStatus(`Transaction submitted: ${txHash}`);
          }
          if (progress.error) {
            throw new Error(progress.error.message || 'Transaction failed');
          }
          if (progress.refunded) {
            throw new Error('Operation failed and was refunded');
          }
        },
      });

      if (txHash) {
        await axios.post('/webhook/sell-completed', {
          userId: session.userId,
          txHash: txHash
        });
        setStatus('Sell completed successfully!');
      } else {
        throw new Error('No transaction hash found');
      }
    } catch (err) {
      console.error('Error during sell:', err);
      setError(`Error during sell: ${err.message || 'Unknown error'}`);
      setStatus('error');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setIsCancelled(true);
    setStatus('Sell cancelled');
    setError('You have cancelled the sell process. You can return to Telegram to start over.');
  };

  useEffect(() => {
    if (wallets.length > 0 && session && !quote && ready && authenticated && !isCancelled) {
      (async () => {
        try {
          const provider = await wallets[0].getEthersProvider();
          const signer = await provider.getSigner();
          const adaptedWallet = adaptEthersSigner(signer);
          await fetchQuote(adaptedWallet);
        } catch (err) {
          console.error('Error initializing wallet for quote:', err);
          setError(`Failed to initialize wallet for quote: ${err.message || 'Unknown error'}`);
          setStatus('error');
        }
      })();
    }
  }, [wallets, session, ready, authenticated, isCancelled]);

  if (!ready) return <div>Loading...</div>;

  return (
    <div className="connect-wallet-app">
      <h1>DirectPay Wallet Connector</h1>
      {!authenticated ? (
        <button onClick={login}>Connect Wallet</button>
      ) : (
        <>
          <p>Connected: {wallets[0]?.address}</p>
          <p>Status: {status}</p>
          {session && !isCancelled ? (
            <>
              <p>Amount: {ethers.utils.formatUnits(session.amountInWei, 6)} {session.token === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'Token'}</p>
              <p>To: {session.blockradarWallet}</p>
              {quote ? (
                <>
                  <p>Quote: {ethers.utils.formatUnits(quote.details.currencyOut.amount, 6)} USDC</p>
                  <p>Fees: {ethers.utils.formatEther(quote.fees?.gas?.amount || '0')} ETH</p>
                  <button onClick={handleSell} disabled={loading}>
                    {loading ? 'Processing...' : 'Execute Sell'}
                  </button>
                  <button onClick={handleCancel} disabled={loading} style={{ marginLeft: '10px', backgroundColor: '#ff4d4f', color: 'white' }}>
                    Cancel Sell
                  </button>
                </>
              ) : (
                <p>{loading ? 'Fetching quote...' : 'Waiting for quote...'}</p>
              )}
            </>
          ) : (
            <p>{isCancelled ? 'Sell process cancelled.' : 'Parsing session...'}</p>
          )}
          <button onClick={logout}>Disconnect</button>
        </>
      )}
      {error && (
        <p className="error">
          {error}
          <br />
          <a href="https://t.me/yourBotUsername">Return to Telegram</a>
        </p>
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
