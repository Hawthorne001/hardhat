/**
 * This files contains the utility functions that the execution engine should
 * use to interact with the network during the execution of a NetworkInteraction.
 *
 * @file
 */

import { IgnitionError } from "../../../../errors";
import { DeploymentLoader } from "../../../deployment-loader/types";
import { ERRORS } from "../../../errors-list";
import { assertIgnitionInvariant } from "../../../utils/assertions";
import { JsonRpcClient, TransactionParams } from "../../jsonrpc-client";
import { NonceManager } from "../../nonce-management/json-rpc-nonce-manager";
import {
  SimulationErrorExecutionResult,
  StrategySimulationErrorExecutionResult,
} from "../../types/execution-result";
import {
  NetworkFees,
  RawStaticCallResult,
  Transaction,
} from "../../types/jsonrpc";
import { JournalMessageType } from "../../types/messages";
import {
  OnchainInteraction,
  StaticCall,
} from "../../types/network-interaction";

/**
 * Runs a StaticCall NetworkInteraction to completion, returning its raw result.
 *
 * @param client The JsonRpcClient to use to interact with the network.
 * @param staticCall The StaticCall to run.
 * @returns The raw result of the StaticCall.
 */
export async function runStaticCall(
  client: JsonRpcClient,
  staticCall: StaticCall
): Promise<RawStaticCallResult> {
  return client.call(
    {
      from: staticCall.from,
      to: staticCall.to,
      data: staticCall.data,
      value: staticCall.value,
    },
    "latest"
  );
}

/**
 * The type of a successful response from `sendTransactionForOnchainInteraction`.
 */
export const TRANSACTION_SENT_TYPE = "TRANSACTION";

/**
 * Sends the a transaction to run an OnchainInteraction.
 *
 * If this is the first transaction being sent for the OnchainInteraction, the
 * nonce will be fetched using the provided callback.
 *
 * This function estimates gas and runs a simulation before sending the transaction.
 *
 * Simulations are run both in the case of a failed gas estimation (to report
 * why it failed), and in the case of a successful gas estimation (to make sure
 * the transaction will not fail, and report any error).
 *
 * This function is meant to be used in conjunction with the ExecutionStrategy's
 * generator that requested the OnchainInteraction, as is its responsibility to
 * decode the result of the simulation. The `decodeSimulationResult` callback is
 * more generic to make this function easier to test, but it should normally
 * call the generator's `next` and return its result, replacing
 * `SimulationSuccessSignal` results with `undefined`.
 *
 * Note that if we are resending a transaction for an OnchainInteraction, we
 * need a new ExecutionStrategy generator to decode the simulation result, as
 * the previous one will be waiting for a confirmed transaction.
 *
 * This function can be used in these cases:
 * - When the OnchainInteraction needs to start being executed (i.e. first tx).
 * - When we detected a dropped transaction and we need to resend it with the
 * same nonce.
 * - When we want to bump the fees of a transaction.
 *
 * This function MUST NOT be used in these cases:
 * - When we detected a dropped transaction and we need to resend it with a
 * different nonce.
 *
 * @param client The JsonRpcClient to use to interact with the network.
 * @param sender The account to send the transaction from.
 * @param onchainInteraction The OnchainInteraction to send the transaction for.
 * @param getNonce A callback to fetch the nonce for the transaction.
 * @param decodeSimulationResult A callback to decode the result of the simulation.
 *  This callback should return undefined if the simulation was successful, or
 *  a SimulationErrorExecutionResult or StrategyErrorExecutionResult if the
 *  simulation failed.
 * @returns Any error returned by decodeSimulationResult or an object with the
 *  transaction hash and nonce.
 */
export async function sendTransactionForOnchainInteraction(
  client: JsonRpcClient,
  sender: string,
  onchainInteraction: OnchainInteraction,
  nonceManager: NonceManager,
  decodeSimulationResult: (
    simulationResult: RawStaticCallResult
  ) => Promise<
    | SimulationErrorExecutionResult
    | StrategySimulationErrorExecutionResult
    | undefined
  >,
  deploymentLoader: DeploymentLoader,
  futureId: string
): Promise<
  | SimulationErrorExecutionResult
  | StrategySimulationErrorExecutionResult
  | {
      type: typeof TRANSACTION_SENT_TYPE;
      transaction: Pick<Transaction, "hash" | "fees">;
      nonce: number;
    }
> {
  const nonce =
    onchainInteraction.nonce ?? (await nonceManager.getNextNonce(sender));
  const fees = await getNextTransactionFees(client, onchainInteraction);

  // TODO: Should we check the balance here? Before or after estimating gas?
  //  Before or after simulating?

  const estimateGasPrams = {
    to: onchainInteraction.to,
    from: sender,
    data: onchainInteraction.data,
    value: onchainInteraction.value,
    nonce,
    fees,
    gasLimit: undefined,
  };

  let gasLimit: bigint;
  try {
    gasLimit = await client.estimateGas(estimateGasPrams);
  } catch (error) {
    // We remove the fees before simulating the transaction since we weren't able to estimate gas
    // and otherwise geth will try to use the block gas limit as `gas`, and most accounts don't
    // have enough balance to pay for that.
    const { fees: _fees, ...paramsWithoutFees } = estimateGasPrams;

    // If the gas estimation failed, we simulate the transaction to get information
    // about why it failed.
    const failedEstimateGasSimulationResult = await client.call(
      paramsWithoutFees,
      "pending"
    );

    const decoded = await decodeSimulationResult(
      failedEstimateGasSimulationResult
    );

    if (decoded !== undefined) {
      return decoded;
    }

    // this is just for type inference
    assertIgnitionInvariant(
      error instanceof Error,
      "Unexpected error type while resolving failed gas estimation"
    );

    // If the user has tried to transfer funds (i.e. m.send(...)) and they have insufficient funds
    if (/insufficient funds for transfer/.test(error.message)) {
      throw new IgnitionError(
        ERRORS.EXECUTION.INSUFFICIENT_FUNDS_FOR_TRANSFER,
        { sender, amount: estimateGasPrams.value.toString() }
      );
    }
    // if the user has insufficient funds to deploy the contract they're trying to deploy
    else if (/contract creation code storage out of gas/.test(error.message)) {
      throw new IgnitionError(ERRORS.EXECUTION.INSUFFICIENT_FUNDS_FOR_DEPLOY, {
        sender,
      });
    }
    // catch-all error for all other errors
    else {
      throw new IgnitionError(ERRORS.EXECUTION.GAS_ESTIMATION_FAILED, {
        error: error.message,
      });
    }
  }

  const transactionParams: TransactionParams = {
    ...estimateGasPrams,
    gasLimit,
  };

  // Before sending the transaction, we simulate it to make sure it will not fail.
  // And to get the return data, which we will need to decode the error if the
  // simulation fails.
  const simulationResult = await client.call(transactionParams, "pending");
  const decodedSimulationResult = await decodeSimulationResult(
    simulationResult
  );

  if (decodedSimulationResult !== undefined) {
    return decodedSimulationResult;
  }

  await deploymentLoader.recordToJournal({
    type: JournalMessageType.TRANSACTION_PREPARE_SEND,
    futureId,
    networkInteractionId: onchainInteraction.id,
    nonce: transactionParams.nonce,
  });

  const txHash = await client.sendTransaction(transactionParams);

  return {
    type: TRANSACTION_SENT_TYPE,
    nonce,
    transaction: {
      hash: txHash,
      fees,
    },
  };
}

/**
 * Returns the fees to use for the next transaction of an OnchainInteraction.
 * If the OnchainInteraction has existing transactions, it will apply the fee
 * bumping logic.
 *
 * @param client The JsonRpcClient to use to interact with the network.
 * @param onchainInteraction The OnchainInteraction to get the fees for.
 */
async function getNextTransactionFees(
  client: JsonRpcClient,
  onchainInteraction: OnchainInteraction
): Promise<NetworkFees> {
  const recommendedFees = await client.getNetworkFees();

  if (onchainInteraction.transactions.length === 0) {
    return recommendedFees;
  }

  // If we send a follow up transaction for an OnchainInteraction we
  // set it higher fees than the previous transaction, so we can get
  // the last one here.
  const transactionWithHighestFees =
    onchainInteraction.transactions[onchainInteraction.transactions.length - 1];

  if ("maxFeePerGas" in recommendedFees) {
    let previousFees: NetworkFees;
    if (!("maxFeePerGas" in transactionWithHighestFees.fees)) {
      // If the previous transaction was not EIP-1559, we use gasPrice in
      // both fields
      previousFees = {
        maxFeePerGas: transactionWithHighestFees.fees.gasPrice,
        maxPriorityFeePerGas: transactionWithHighestFees.fees.gasPrice,
      };
    } else {
      previousFees = transactionWithHighestFees.fees;
    }

    const bumpedFees = {
      maxFeePerGas: (previousFees.maxFeePerGas * 110n) / 100n,
      maxPriorityFeePerGas: (previousFees.maxPriorityFeePerGas * 110n) / 100n,
    };

    const maxFeePerGas =
      recommendedFees.maxFeePerGas > bumpedFees.maxFeePerGas
        ? recommendedFees.maxFeePerGas
        : bumpedFees.maxFeePerGas;

    const maxPriorityFeePerGas =
      recommendedFees.maxPriorityFeePerGas > bumpedFees.maxPriorityFeePerGas
        ? recommendedFees.maxPriorityFeePerGas
        : bumpedFees.maxPriorityFeePerGas;

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  assertIgnitionInvariant(
    "gasPrice" in transactionWithHighestFees.fees,
    "EIP-1559 transaction was already sent but the currently recommended fees are not EIP-1559"
  );

  const bumpedGasPrice =
    (transactionWithHighestFees.fees.gasPrice * 110n) / 100n;

  const maxGasPrice =
    recommendedFees.gasPrice > bumpedGasPrice
      ? recommendedFees.gasPrice
      : bumpedGasPrice;

  return { gasPrice: maxGasPrice };
}
