import {toWords} from '../vendors/Daefen';
import {fromBrainWallet} from '../utils';

class BackupService {
  constructor(walletContractService, generateWallet = fromBrainWallet) {
    this.walletContractService = walletContractService;
    this.backupCodes = [];
    this.publicKeys = [];
    this.generateWallet = generateWallet;
  }

  clearBackupCodes() {
    this.backupCodes = [];
    this.publicKeys = [];
  }

  async generateBackupCodes(numCodes) {
    for (let index = 0; index < numCodes; index++) {
      const prefix = toWords(Math.floor(Math.random() * Math.pow(3456, 4)))
        .replace(/\s/g, '-');
      const suffix = toWords(Math.floor(Math.random() * Math.pow(3456, 4)))
        .replace(/\s/g, '-');
      const backupCode = `${prefix}-${suffix}`;
      const wallet = await this.generateWallet(this.walletContractService.walletContract.name, backupCode);
      this.backupCodes.push(backupCode);
      this.publicKeys.push(wallet.address);
    }
    return [this.backupCodes, this.publicKeys];
  }
}

export default BackupService;
