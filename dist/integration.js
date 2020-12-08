"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const _ = require("lodash");
const api_1 = require("./api");
const utils_1 = require("./utils");
class Integration {
    constructor({ config, awsProvider, serverless, region, licenseKey }) {
        this.config = config;
        this.awsProvider = awsProvider;
        this.serverless = serverless;
        this.region = region;
        this.licenseKey = licenseKey;
    }
    check() {
        return __awaiter(this, void 0, void 0, function* () {
            const { accountId, enableIntegration, apiKey } = this.config;
            const { linkedAccount = `New Relic Lambda Integration - ${accountId}` } = this.config;
            const integrationData = yield api_1.nerdgraphFetch(apiKey, this.region, api_1.fetchLinkedAccounts(accountId));
            const linkedAccounts = _.get(integrationData, "data.actor.account.cloud.linkedAccounts", []);
            const externalId = yield this.getCallerIdentity();
            const match = linkedAccounts.filter(account => {
                return (account.name === linkedAccount &&
                    account.externalId === externalId &&
                    account.nrAccountId === accountId);
            });
            if (match.length < 1) {
                this.serverless.cli.log("No New Relic AWS Lambda integration found for this New Relic linked account and aws account.");
                if (enableIntegration) {
                    this.enable(externalId);
                    return;
                }
                this.serverless.cli.log("Please enable the configuration manually or add the 'enableIntegration' config var to your serverless.yaml file.");
                return;
            }
            this.serverless.cli.log("Existing New Relic integration found for this linked account and aws account, skipping creation.");
        });
    }
    createManagedSecret() {
        return __awaiter(this, void 0, void 0, function* () {
            const stackName = `NewRelicLicenseKeySecret`;
            try {
                const policy = yield utils_1.fetchPolicy("nr-license-key-secret.yaml");
                const params = {
                    Capabilities: ["CAPABILITY_NAMED_IAM"],
                    Parameters: [
                        {
                            ParameterKey: "LicenseKey",
                            ParameterValue: this.licenseKey
                        },
                        {
                            ParameterKey: "Region",
                            ParameterValue: this.region
                        }
                    ],
                    StackName: stackName,
                    TemplateBody: policy
                };
                const { StackId } = yield this.awsProvider.request("CloudFormation", "createStack", params);
                return StackId;
            }
            catch (err) {
                // If the secret already exists, we'll see an error, but we populate
                // a return value anyway to avoid falling back to the env var.
                if (`${err}`.indexOf("NewRelicLicenseKeySecret") > -1 &&
                    `${err}`.indexOf("already exists") > -1) {
                    return "Already created";
                }
                this.serverless.cli.log(`Something went wrong while creating NewRelicLicenseKeySecret: ${err}`);
            }
            return false;
        });
    }
    enable(externalId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const roleArn = yield this.checkAwsIntegrationRole(externalId);
                if (!roleArn) {
                    return;
                }
                const { accountId, apiKey } = this.config;
                const { linkedAccount = `New Relic Lambda Integration - ${accountId}` } = this.config;
                this.serverless.cli.log(`Enabling New Relic integration for linked account: ${linkedAccount} and aws account: ${externalId}.`);
                const res = yield api_1.nerdgraphFetch(apiKey, this.region, api_1.cloudLinkAccountMutation(accountId, roleArn, linkedAccount));
                const { linkedAccounts, errors } = _.get(res, "data.cloudLinkAccount", {
                    errors: ["data.cloudLinkAccount missing in response"]
                });
                if (errors && errors.length) {
                    throw new Error(errors);
                }
                const linkedAccountId = _.get(linkedAccounts, "[0].id");
                const integrationRes = yield api_1.nerdgraphFetch(apiKey, this.region, api_1.cloudServiceIntegrationMutation(accountId, "aws", "lambda", linkedAccountId));
                const { errors: integrationErrors } = _.get(integrationRes, "data.cloudConfigureIntegration", {
                    errors: ["data.cloudConfigureIntegration missing in response"]
                });
                if (integrationErrors && integrationErrors.length) {
                    throw new Error(integrationErrors);
                }
                this.serverless.cli.log(`New Relic AWS Lambda cloud integration created successfully.`);
            }
            catch (err) {
                this.serverless.cli.log(`Error while creating the New Relic AWS Lambda cloud integration: ${err}.`);
            }
        });
    }
    getCallerIdentity() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { Account } = yield this.awsProvider.request("STS", "getCallerIdentity", {});
                return Account;
            }
            catch (err) {
                this.serverless.cli.log("No AWS config found, please configure a default AWS config.");
            }
        });
    }
    checkAwsIntegrationRole(externalId) {
        return __awaiter(this, void 0, void 0, function* () {
            const { accountId } = this.config;
            if (!accountId) {
                this.serverless.cli.log("No New Relic Account ID specified; Cannot check for required NewRelicLambdaIntegrationRole.");
                return;
            }
            try {
                const params = {
                    RoleName: `NewRelicLambdaIntegrationRole_${accountId}`
                };
                const { Role: { Arn } } = yield this.awsProvider.request("IAM", "getRole", params);
                return Arn;
            }
            catch (err) {
                this.serverless.cli.log("The required NewRelicLambdaIntegrationRole cannot be found; Creating Stack with NewRelicLambdaIntegrationRole.");
                const stackId = yield this.createCFStack(accountId);
                utils_1.waitForStatus({
                    awsMethod: "describeStacks",
                    callbackMethod: () => this.enable(externalId),
                    methodParams: {
                        StackName: stackId
                    },
                    statusPath: "Stacks[0].StackStatus"
                }, this);
            }
        });
    }
    createCFStack(accountId) {
        return __awaiter(this, void 0, void 0, function* () {
            const stackName = `NewRelicLambdaIntegrationRole-${accountId}`;
            const { customRolePolicy = "" } = this.config;
            try {
                const policy = yield utils_1.fetchPolicy("nr-lambda-integration-role.yaml");
                const params = {
                    Capabilities: ["CAPABILITY_NAMED_IAM"],
                    Parameters: [
                        {
                            ParameterKey: "NewRelicAccountNumber",
                            ParameterValue: accountId.toString()
                        },
                        { ParameterKey: "PolicyName", ParameterValue: customRolePolicy }
                    ],
                    StackName: stackName,
                    TemplateBody: policy
                };
                const { StackId } = yield this.awsProvider.request("CloudFormation", "createStack", params);
                return StackId;
            }
            catch (err) {
                this.serverless.cli.log(`Something went wrong while creating NewRelicLambdaIntegrationRole: ${err}`);
            }
        });
    }
}
exports.default = Integration;
