import {utils, Contract, providers} from 'ethers';
import WalletContract from '@universal-login/contracts/build/WalletMaster.json';
import {TokensValueConverter, TokenDetails, TokenDetailsService, Notification, generateCode, addCodesToNotifications, resolveName, MANAGEMENT_KEY, waitForContractDeploy, Message, createSignedMessage, MessageWithFrom, ensureNotNull, PublicRelayerConfig, createKeyPair, signCancelAuthorisationRequest, signGetAuthorisationRequest, ensure, BalanceChecker, deepMerge, DeepPartial, SignedMessage} from '@universal-login/commons';
import AuthorisationsObserver from '../core/observers/AuthorisationsObserver';
import BlockchainObserver from '../core/observers/BlockchainObserver';
import {DeploymentReadyObserver} from '../core/observers/DeploymentReadyObserver';
import {DeploymentObserver} from '../core/observers/DeploymentObserver';
import {RelayerApi} from '../integration/http/RelayerApi';
import {BlockchainService} from '../integration/ethereum/BlockchainService';
import {MissingConfiguration, InvalidEvent, InvalidContract} from '../core/utils/errors';
import {FutureWalletFactory} from './FutureWalletFactory';
import {ExecutionFactory, Execution} from '../core/services/ExecutionFactory';
import {BalanceObserver} from '../core/observers/BalanceObserver';
import {SdkConfigDefault} from '../config/SdkConfigDefault';
import {SdkConfig} from '../config/SdkConfig';
import {AggregateBalanceObserver} from '../core/observers/AggregateBalanceObserver';
import {PriceObserver} from '../core/observers/PriceObserver';
import {TokensDetailsStore} from '../integration/ethereum/TokensDetailsStore';

class UniversalLoginSDK {
  provider: providers.Provider;
  relayerApi: RelayerApi;
  authorisationsObserver: AuthorisationsObserver;
  blockchainObserver: BlockchainObserver;
  executionFactory: ExecutionFactory;
  deploymentReadyObserver?: DeploymentReadyObserver;
  deploymentObserver?: DeploymentObserver;
  balanceChecker: BalanceChecker;
  balanceObserver?: BalanceObserver;
  tokensValueConverter: TokensValueConverter;
  aggregateBalanceObserver?: AggregateBalanceObserver;
  priceObserver: PriceObserver;
  tokenDetailsService: TokenDetailsService;
  tokensDetailsStore: TokensDetailsStore;
  blockchainService: BlockchainService;
  futureWalletFactory?: FutureWalletFactory;
  sdkConfig: SdkConfig;
  relayerConfig?: PublicRelayerConfig;
  factoryAddress?: string;

  constructor(
    relayerUrl: string,
    providerOrUrl: string | providers.Provider,
    sdkConfig?: DeepPartial<SdkConfig>
  ) {
    this.provider = typeof(providerOrUrl) === 'string' ?
      new providers.JsonRpcProvider(providerOrUrl, {chainId: 0} as any)
      : providerOrUrl;
    this.relayerApi = new RelayerApi(relayerUrl);
    this.authorisationsObserver = new AuthorisationsObserver(this.relayerApi);
    this.executionFactory = new ExecutionFactory(this.relayerApi);
    this.blockchainService = new BlockchainService(this.provider);
    this.blockchainObserver = new BlockchainObserver(this.blockchainService);
    this.balanceChecker = new BalanceChecker(this.provider);
    this.sdkConfig = deepMerge(SdkConfigDefault, sdkConfig);
    this.tokenDetailsService = new TokenDetailsService(this.provider);
    this.tokensDetailsStore = new TokensDetailsStore(this.tokenDetailsService, this.sdkConfig.observedTokens.map((token) => token.address));
    this.tokensDetailsStore.fetchTokensDetails();
    this.priceObserver = new PriceObserver(this.sdkConfig.observedTokens, this.sdkConfig.observedCurrencies);
    this.tokensValueConverter = new TokensValueConverter(this.sdkConfig.observedCurrencies);
  }

  async create(ensName: string): Promise<[string, string]> {
    const {publicKey, privateKey} = createKeyPair();
    const result = await this.relayerApi.createWallet(publicKey, ensName);
    const contract = await waitForContractDeploy(
      this.provider,
      WalletContract,
      result.transaction.hash,
    );
    return [privateKey, contract.address];
  }

  async createFutureWallet() {
    await this.getRelayerConfig();
    this.fetchFutureWalletFactory();
    return this.futureWalletFactory!.createFutureWallet();
  }

  async addKey(to: string, publicKey: string, privateKey: string, transactionDetails: Message, keyPurpose = MANAGEMENT_KEY) {
    return this.selfExecute(to, 'addKey', [publicKey, keyPurpose], privateKey, transactionDetails);
  }

  async addKeys(to: string, publicKeys: string[], privateKey: string, transactionDetails: Message, keyPurpose = MANAGEMENT_KEY) {
    const keyRoles = new Array(publicKeys.length).fill(keyPurpose);
    return this.selfExecute(to, 'addKeys', [publicKeys, keyRoles], privateKey, transactionDetails);
  }

  async removeKey(to: string, key: string, privateKey: string, transactionDetails: Message) {
    return this.selfExecute(to, 'removeKey', [key, MANAGEMENT_KEY], privateKey, transactionDetails);
  }

  async setRequiredSignatures(to: string, requiredSignatures: number, privateKey: string, transactionDetails: Message) {
    return this.selfExecute(to, 'setRequiredSignatures', [requiredSignatures], privateKey, transactionDetails);
  }

  async getMessageStatus(messageHash: string) {
    return this.relayerApi.getStatus(messageHash);
  }

  async getRelayerConfig() {
    this.relayerConfig = this.relayerConfig || (await this.relayerApi.getConfig()).config;
    return this.relayerConfig;
  }

  async fetchDeploymentReadyObserver() {
    ensureNotNull(this.relayerConfig, MissingConfiguration);
    this.deploymentReadyObserver = this.deploymentReadyObserver || new DeploymentReadyObserver(this.relayerConfig!.supportedTokens, this.provider);
  }

  async fetchDeploymentObserver() {
    ensureNotNull(this.relayerConfig, MissingConfiguration);
    this.deploymentObserver = this.deploymentObserver || new DeploymentObserver(this.blockchainService, this.relayerConfig!.contractWhiteList);
  }

  async fetchBalanceObserver(ensName: string) {
    if (this.balanceObserver) {
      return;
    }
    const walletContractAddress = await this.getWalletContractAddress(ensName);
    ensureNotNull(walletContractAddress, InvalidContract);
    ensureNotNull(this.relayerConfig, MissingConfiguration);

    const tokenDetails = await this.getTokensDetails();
    this.balanceObserver = new BalanceObserver(this.balanceChecker, walletContractAddress, tokenDetails);
  }

  async fetchAggregateBalanceObserver(ensName: string) {
    if (this.aggregateBalanceObserver) {
      return;
    }
    await this.fetchBalanceObserver(ensName);
    this.aggregateBalanceObserver = new AggregateBalanceObserver(this.balanceObserver!, this.priceObserver, this.tokensValueConverter);
  }

  async getTokensDetails() {
    const tokenDetails: TokenDetails[] = [];
    for (const token of this.sdkConfig.observedTokens) {
      const name = await this.tokenDetailsService.getName(token.address);
      const symbol = await this.tokenDetailsService.getSymbol(token.address);
      tokenDetails.push({...token, name, symbol});
    }
    return tokenDetails;
  }

  private fetchFutureWalletFactory() {
    ensureNotNull(this.relayerConfig, Error, 'Relayer configuration not yet loaded');
    const futureWalletConfig = {
      supportedTokens: this.relayerConfig!.supportedTokens,
      factoryAddress: this.relayerConfig!.factoryAddress,
      contractWhiteList: this.relayerConfig!.contractWhiteList,
      chainSpec: this.relayerConfig!.chainSpec
    };
    this.futureWalletFactory = this.futureWalletFactory || new FutureWalletFactory(futureWalletConfig, this.provider, this.blockchainService, this.relayerApi);
  }

  async execute(message: Message, privateKey: string): Promise<Execution> {
    const unsignedMessage = {
      ...this.sdkConfig.paymentOptions,
      ...message,
      nonce: message.nonce || parseInt(await this.getNonce(message.from!), 10),
    } as MessageWithFrom;
    const signedMessage: SignedMessage = createSignedMessage(unsignedMessage, privateKey);
    return this.executionFactory.createExecution(signedMessage);
  }

  protected selfExecute(to: string, method: string , args: any[], privateKey: string, transactionDetails: Message) {
    const data = new utils.Interface(WalletContract.interface).functions[method].encode(args);
    const message = {
      ...transactionDetails,
      to,
      from: to,
      data
    };
    return this.execute(message, privateKey);
  }

  async getKeyPurpose(walletContractAddress: string, key: string) {
    const walletContract = new Contract(walletContractAddress, WalletContract.interface, this.provider);
    return walletContract.getKeyPurpose(key);
  }

  async getNonce(walletContractAddress: string) {
    const contract = new Contract(walletContractAddress, WalletContract.interface, this.provider);
    return contract.lastNonce();
  }

  async getWalletContractAddress(ensName: string) {
    const walletContractAddress = await this.resolveName(ensName);
    if (walletContractAddress && await this.blockchainService.getCode(walletContractAddress)) {
      return walletContractAddress;
    }
    return null;
  }

  async walletContractExist(ensName: string) {
    const walletContractAddress = await this.getWalletContractAddress(ensName);
    return walletContractAddress !== null;
  }

  async resolveName(ensName: string) {
    await this.getRelayerConfig();
    const {ensAddress} = this.relayerConfig!.chainSpec;
    return resolveName(this.provider, ensAddress, ensName);
  }

  async connect(walletContractAddress: string) {
    const {publicKey, privateKey} = createKeyPair();
    await this.relayerApi.connect(walletContractAddress, publicKey);
    return {
      privateKey,
      securityCode: generateCode(publicKey)
    };
  }

  async denyRequest(walletContractAddress: string, publicKey: string, privateKey: string) {
    const cancelAuthorisationRequest = {walletContractAddress, publicKey};
    signCancelAuthorisationRequest(cancelAuthorisationRequest, privateKey);
    await this.relayerApi.denyConnection(cancelAuthorisationRequest);
    return publicKey;
  }

  subscribe(eventType: string, filter: any, callback: Function) {
    ensure(['KeyAdded', 'KeyRemoved'].includes(eventType), InvalidEvent, eventType);
    return this.blockchainObserver.subscribe(eventType, filter, callback);
  }

  async subscribeToBalances(ensName: string, callback: Function) {
    await this.fetchBalanceObserver(ensName);
    return this.balanceObserver!.subscribe(callback);
  }

  async subscribeToAggregatedBalance(ensName: string, callback: Function) {
    await this.fetchAggregateBalanceObserver(ensName);
    return this.aggregateBalanceObserver!.subscribe(callback);
  }

  subscribeToPrices(callback: Function) {
    return this.priceObserver.subscribe(callback);
  }

  subscribeAuthorisations(walletContractAddress: string, privateKey: string, callback: Function) {
    return this.authorisationsObserver.subscribe(
      signGetAuthorisationRequest({walletContractAddress}, privateKey),
      (notifications: Notification[]) => callback(addCodesToNotifications(notifications))
    );
  }

  async start() {
    await this.blockchainObserver.start();
  }

  stop() {
    this.blockchainObserver.stop();
  }

  async finalizeAndStop() {
    await this.blockchainObserver.finalizeAndStop();
  }
}

export default UniversalLoginSDK;
