import {utils} from 'ethers';
import {CancelAuthorisationRequest} from '../../models/authorisation';
import {sign} from '../signatures';

export const hashCancelAuthorisationRequest =
  (cancelAuthorisationRequest: CancelAuthorisationRequest): string => {
    const {walletContractAddress, publicKey} = cancelAuthorisationRequest;
    return utils.solidityKeccak256(['bytes20', 'bytes20'], [walletContractAddress, publicKey]);
  };

export const signCancelAuthorisationRequest =
  (cancelAuthorisationRequest: CancelAuthorisationRequest, privateKey: string) => {
    const payloadDigest = hashCancelAuthorisationRequest(cancelAuthorisationRequest);
    cancelAuthorisationRequest.signature = sign(payloadDigest, privateKey);
    return cancelAuthorisationRequest;
  };

export const recoverFromCancelAuthorisationRequest =
  (cancelAuthorisationRequest: CancelAuthorisationRequest): string => {
    const payloadDigest = hashCancelAuthorisationRequest(cancelAuthorisationRequest);
    return utils.verifyMessage(utils.arrayify(payloadDigest), cancelAuthorisationRequest.signature!);
  };

export const verifyCancelAuthorisationRequest =
  (cancelAuthorisationRequest: CancelAuthorisationRequest, address: string): boolean => {
    const computedAddress = recoverFromCancelAuthorisationRequest(cancelAuthorisationRequest);
    return computedAddress === address;
  };
