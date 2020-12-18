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
const fs = require("fs-extra");
const _ = require("lodash");
const path = require("path");
const request = require("request-promise-native");
const semver = require("semver");
const api_1 = require("./api");
const integration_1 = require("./integration");
const utils_1 = require("./utils");
const DEFAULT_FILTER_PATTERNS = [
    "REPORT",
    "NR_LAMBDA_MONITORING",
    "Task timed out",
    "RequestId"
];
class NewRelicLambdaLayerPlugin {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;
        this.awsProvider = this.serverless.getProvider("aws");
        this.region = _.get(this.serverless.service, "provider.region", "us-east-1");
        this.licenseKey = null;
        this.managedSecretConfigured = false;
        this.hooks = this.shouldSkipPlugin()
            ? {}
            : {
                "after:deploy:deploy": this.addLogSubscriptions.bind(this),
                "after:deploy:function:packageFunction": this.cleanup.bind(this),
                "after:package:createDeploymentArtifacts": this.cleanup.bind(this),
                "before:deploy:deploy": this.checkIntegration.bind(this),
                "before:deploy:function:packageFunction": this.run.bind(this),
                "before:package:createDeploymentArtifacts": this.run.bind(this),
                "before:remove:remove": this.removeLogSubscriptions.bind(this)
            };
    }
    get config() {
        return _.get(this.serverless, "service.custom.newRelic", {});
    }
    get stage() {
        return ((this.options && this.options.stage) ||
            (this.serverless.service.provider &&
                this.serverless.service.provider.stage));
    }
    get prependLayer() {
        return typeof this.config.prepend === "boolean" && this.config.prepend;
    }
    get autoSubscriptionDisabled() {
        return (typeof this.config.disableAutoSubscription === "boolean" &&
            this.config.disableAutoSubscription);
    }
    get functions() {
        return Object.assign.apply(null, this.serverless.service
            .getAllFunctions()
            .map(func => ({ [func]: this.serverless.service.getFunction(func) })));
    }
    checkIntegration() {
        return new integration_1.default(this).check();
    }
    configureLicenseForExtension() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.licenseKey) {
                this.licenseKey = yield this.retrieveLicenseKey();
            }
            const managedSecret = yield new integration_1.default(this).createManagedSecret();
            if (managedSecret) {
                this.managedSecretConfigured = true;
            }
        });
    }
    run() {
        return __awaiter(this, void 0, void 0, function* () {
            const version = this.serverless.getVersion();
            if (semver.lt(version, "1.34.0")) {
                this.serverless.cli.log(`Serverless ${version} does not support layers. Please upgrade to >=1.34.0.`);
                return;
            }
            let plugins = _.get(this.serverless, "service.plugins", []);
            if (!_.isArray(plugins) && plugins.modules) {
                plugins = plugins.modules;
            }
            this.serverless.cli.log(`Plugins: ${JSON.stringify(plugins)}`);
            if (plugins.indexOf("serverless-webpack") >
                plugins.indexOf("serverless-newrelic-lambda-layers")) {
                this.serverless.cli.log("serverless-newrelic-lambda-layers plugin must come after serverless-webpack in serverless.yml; skipping.");
                return;
            }
            const { exclude = [], include = [] } = this.config;
            if (!_.isEmpty(exclude) && !_.isEmpty(include)) {
                this.serverless.cli.log("exclude and include options are mutually exclusive; skipping.");
                return;
            }
            if (this.config.enableExtension !== false) {
                this.config.enableExtension = true;
                // If using the extension, try to store the NR license key in a managed secret
                // for the extension to authenticate. If not, fall back to function environment variable
                yield this.configureLicenseForExtension();
            }
            const funcs = this.functions;
            const promises = [];
            for (const funcName of Object.keys(funcs)) {
                const funcDef = funcs[funcName];
                promises.push(this.addLayer(funcName, funcDef));
            }
            yield Promise.all(promises);
        });
    }
    cleanup() {
        this.removeNodeHelper();
    }
    addLogSubscriptions() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.autoSubscriptionDisabled) {
                this.serverless.cli.log("Skipping adding log subscription. Explicitly disabled");
                return;
            }
            const funcs = this.functions;
            let { cloudWatchFilter = [...DEFAULT_FILTER_PATTERNS] } = this.config;
            let cloudWatchFilterString = "";
            if (typeof cloudWatchFilter === "object" &&
                cloudWatchFilter.indexOf("*") === -1) {
                cloudWatchFilter = cloudWatchFilter.map(el => `?\"${el}\"`);
                cloudWatchFilterString = cloudWatchFilter.join(" ");
            }
            else if (cloudWatchFilter.indexOf("*") === -1) {
                cloudWatchFilterString = String(cloudWatchFilter);
            }
            this.serverless.cli.log(`log filter: ${cloudWatchFilterString}`);
            const promises = [];
            for (const funcName of Object.keys(funcs)) {
                if (this.shouldSkipFunction(funcName)) {
                    return;
                }
                this.serverless.cli.log(`Configuring New Relic log subscription for ${funcName}`);
                const funcDef = funcs[funcName];
                promises.push(this.ensureLogSubscription(funcDef.name, cloudWatchFilterString));
            }
            yield Promise.all(promises);
        });
    }
    removeLogSubscriptions() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.autoSubscriptionDisabled) {
                this.serverless.cli.log("Skipping removing log subscription. Explicitly disabled");
                return;
            }
            const funcs = this.functions;
            const promises = [];
            for (const funcName of Object.keys(funcs)) {
                const { name } = funcs[funcName];
                this.serverless.cli.log(`Removing New Relic log subscription for ${funcName}`);
                promises.push(this.removeSubscriptionFilter(name));
            }
            yield Promise.all(promises);
        });
    }
    addLayer(funcName, funcDef) {
        return __awaiter(this, void 0, void 0, function* () {
            this.serverless.cli.log(`Adding NewRelic layer to ${funcName}`);
            if (!this.region) {
                this.serverless.cli.log("No AWS region specified for NewRelic layer; skipping.");
                return;
            }
            const { name, environment = {}, handler, runtime = _.get(this.serverless.service, "provider.runtime"), layers = [], package: pkg = {} } = funcDef;
            if (!this.config.accountId && !environment.NEW_RELIC_ACCOUNT_ID) {
                this.serverless.cli.log(`No New Relic Account ID specified for "${funcName}"; skipping.`);
                return;
            }
            const wrappableRuntime = [
                "nodejs10.x",
                "nodejs12.x",
                "nodejs8.10",
                "python2.7",
                "python3.6",
                "python3.7",
                "python3.8"
            ].indexOf(runtime) === -1;
            if (typeof runtime !== "string" ||
                (wrappableRuntime && !this.config.enableExtension)) {
                this.serverless.cli.log(`Unsupported runtime "${runtime}" for NewRelic layer; skipping.`);
                return;
            }
            if (this.shouldSkipFunction(funcName)) {
                return;
            }
            const layerArn = this.config.layerArn
                ? this.config.layerArn
                : yield this.getLayerArn(runtime);
            const newRelicLayers = layers.filter(layer => typeof layer === "string" && layer.match(layerArn));
            // Note: This is if the user specifies a layer in their serverless.yml
            if (newRelicLayers.length) {
                this.serverless.cli.log(`Function "${funcName}" already specifies an NewRelic layer; skipping.`);
            }
            else {
                if (this.prependLayer) {
                    layers.unshift(layerArn);
                }
                else {
                    layers.push(layerArn);
                }
                funcDef.layers = layers;
            }
            environment.NEW_RELIC_LAMBDA_HANDLER = handler;
            if (this.config.logEnabled === true) {
                this.logLevel(environment);
            }
            environment.NEW_RELIC_NO_CONFIG_FILE = environment.NEW_RELIC_NO_CONFIG_FILE
                ? environment.NEW_RELIC_NO_CONFIG_FILE
                : "true";
            environment.NEW_RELIC_APP_NAME = environment.NEW_RELIC_APP_NAME
                ? environment.NEW_RELIC_APP_NAME
                : name || funcName;
            environment.NEW_RELIC_ACCOUNT_ID = environment.NEW_RELIC_ACCOUNT_ID
                ? environment.NEW_RELIC_ACCOUNT_ID
                : this.config.accountId;
            environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY = environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
                ? environment.NEW_RELIC_TRUSTED_ACCOUNT_KEY
                : environment.NEW_RELIC_ACCOUNT_ID
                    ? environment.NEW_RELIC_ACCOUNT_ID
                    : this.config.trustedAccountKey;
            if (runtime.match("python")) {
                environment.NEW_RELIC_SERVERLESS_MODE_ENABLED = "true";
            }
            if (this.config.enableExtension) {
                environment.NEW_RELIC_LAMBDA_EXTENSION_ENABLED = "true";
                if (!this.managedSecretConfigured && this.licenseKey) {
                    environment.NEW_RELIC_LICENSE_KEY = this.licenseKey;
                }
                if (this.config.enableFunctionLogs) {
                    environment.NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS = "true";
                    this.config.disableAutoSubscription = true;
                }
            }
            else {
                environment.NEW_RELIC_LAMBDA_EXTENSION_ENABLED = "false";
            }
            funcDef.environment = environment;
            funcDef.handler = this.getHandlerWrapper(runtime, handler);
            funcDef.package = this.updatePackageExcludes(runtime, pkg);
        });
    }
    shouldSkipPlugin() {
        if (!this.config.stages ||
            (this.config.stages && this.config.stages.includes(this.stage))) {
            return false;
        }
        this.serverless.cli.log(`Skipping plugin serverless-newrelic-lambda-layers for stage ${this.stage}`);
        return true;
    }
    shouldSkipFunction(funcName) {
        const { include = [], exclude = [] } = this.config;
        if (!_.isEmpty(include) &&
            _.isArray(include) &&
            include.indexOf(funcName) === -1) {
            this.serverless.cli.log(`Excluded function ${funcName}; is not part of include skipping`);
            return true;
        }
        if (_.isArray(exclude) && exclude.indexOf(funcName) !== -1) {
            this.serverless.cli.log(`Excluded function ${funcName}; skipping`);
            return true;
        }
        return false;
    }
    logLevel(environment) {
        environment.NEW_RELIC_LOG_ENABLED = "true";
        environment.NEW_RELIC_LOG = environment.NEW_RELIC_LOG
            ? environment.NEW_RELIC_LOG
            : "stdout";
        if (!environment.NEW_RELIC_LOG_LEVEL) {
            const globalNewRelicLogLevel = _.get(this.serverless.service, "provider.environment.NEW_RELIC_LOG_LEVEL");
            if (globalNewRelicLogLevel) {
                environment.NEW_RELIC_LOG_LEVEL = globalNewRelicLogLevel;
            }
            else if (this.config.logLevel) {
                environment.NEW_RELIC_LOG_LEVEL = this.config.logLevel;
            }
            else if (this.config.debug) {
                environment.NEW_RELIC_LOG_LEVEL = "debug";
            }
            else {
                environment.NEW_RELIC_LOG_LEVEL = "error";
            }
        }
    }
    getLayerArn(runtime) {
        return __awaiter(this, void 0, void 0, function* () {
            return request(`https://${this.region}.layers.newrelic-external.com/get-layers?CompatibleRuntime=${runtime}`).then(response => {
                const awsResp = JSON.parse(response);
                return _.get(awsResp, "Layers[0].LatestMatchingVersion.LayerVersionArn");
            });
        });
    }
    getHandlerWrapper(runtime, handler) {
        if (["nodejs10.x", "nodejs12.x"].indexOf(runtime) !== -1) {
            return "newrelic-lambda-wrapper.handler";
        }
        if (runtime === "nodejs8.10") {
            this.addNodeHelper();
            return "newrelic-wrapper-helper.handler";
        }
        if (runtime.match("python")) {
            return "newrelic_lambda_wrapper.handler";
        }
        return handler;
    }
    addNodeHelper() {
        const helperPath = path.join(this.serverless.config.servicePath, "newrelic-wrapper-helper.js");
        if (!fs.existsSync(helperPath)) {
            fs.writeFileSync(helperPath, "module.exports = require('newrelic-lambda-wrapper');");
        }
    }
    removeNodeHelper() {
        const helperPath = path.join(this.serverless.config.servicePath, "newrelic-wrapper-helper.js");
        if (fs.existsSync(helperPath)) {
            fs.removeSync(helperPath);
        }
    }
    updatePackageExcludes(runtime, pkg) {
        if (!runtime.match("nodejs")) {
            return pkg;
        }
        const { exclude = [] } = pkg;
        exclude.push("!newrelic-wrapper-helper.js");
        pkg.exclude = exclude;
        return pkg;
    }
    ensureLogSubscription(funcName, cloudWatchFilterString) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.awsProvider.request("Lambda", "getFunction", {
                    FunctionName: funcName
                });
            }
            catch (err) {
                if (err.providerError) {
                    this.serverless.cli.log(err.providerError.message);
                }
                return;
            }
            let destinationArn;
            const { logIngestionFunctionName = "newrelic-log-ingestion", apiKey } = this.config;
            try {
                destinationArn = yield this.getDestinationArn(logIngestionFunctionName);
            }
            catch (err) {
                this.serverless.cli.log(`Could not find a \`${logIngestionFunctionName}\` function installed.`);
                this.serverless.cli.log("Details about setup requirements are available here: https://docs.newrelic.com/docs/serverless-function-monitoring/aws-lambda-monitoring/get-started/enable-new-relic-monitoring-aws-lambda#enable-process");
                if (err.providerError) {
                    this.serverless.cli.log(err.providerError.message);
                }
                if (!apiKey) {
                    this.serverless.cli.log("Unable to create newrelic-log-ingestion because New Relic API key not configured.");
                    return;
                }
                this.serverless.cli.log(`creating required newrelic-log-ingestion function in region ${this.region}`);
                this.addLogIngestionFunction();
                return;
            }
            let subscriptionFilters;
            try {
                subscriptionFilters = yield this.describeSubscriptionFilters(funcName);
            }
            catch (err) {
                if (err.providerError) {
                    this.serverless.cli.log(err.providerError.message);
                }
                return;
            }
            const competingFilters = subscriptionFilters.filter(filter => filter.filterName !== "NewRelicLogStreaming");
            if (competingFilters.length) {
                this.serverless.cli.log("WARNING: Found a log subscription filter that was not installed by New Relic. This may prevent the New Relic log subscription filter from being installed. If you know you don't need this log subscription filter, you should first remove it and rerun this command. If your organization requires this log subscription filter, please contact New Relic at serverless@newrelic.com for assistance with getting the AWS log subscription filter limit increased.");
            }
            const existingFilters = subscriptionFilters.filter(filter => filter.filterName === "NewRelicLogStreaming");
            if (existingFilters.length) {
                this.serverless.cli.log(`Found log subscription for ${funcName}, verifying configuration`);
                yield Promise.all(existingFilters
                    .filter(filter => filter.filterPattern !== cloudWatchFilterString)
                    .map((filter) => __awaiter(this, void 0, void 0, function* () { return this.removeSubscriptionFilter(funcName); }))
                    .map((filter) => __awaiter(this, void 0, void 0, function* () {
                    return this.addSubscriptionFilter(funcName, destinationArn, cloudWatchFilterString);
                })));
            }
            else {
                this.serverless.cli.log(`Adding New Relic log subscription to ${funcName}`);
                yield this.addSubscriptionFilter(funcName, destinationArn, cloudWatchFilterString);
            }
        });
    }
    getDestinationArn(logIngestionFunctionName) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.awsProvider
                .request("Lambda", "getFunction", {
                FunctionName: logIngestionFunctionName
            })
                .then(res => res.Configuration.FunctionArn);
        });
    }
    addLogIngestionFunction() {
        return __awaiter(this, void 0, void 0, function* () {
            const templateUrl = yield this.getSarTemplate();
            if (!templateUrl) {
                this.serverless.cli.log("Unable to create newRelic-log-ingestion without sar template.");
                return;
            }
            try {
                const mode = "CREATE";
                const stackName = "NewRelic-log-ingestion";
                const changeSetName = `${stackName}-${mode}-${Date.now()}`;
                const parameters = yield this.formatFunctionVariables();
                const params = {
                    Capabilities: ["CAPABILITY_IAM"],
                    ChangeSetName: changeSetName,
                    ChangeSetType: mode,
                    Parameters: parameters,
                    StackName: stackName,
                    TemplateURL: templateUrl
                };
                const { Id, StackId } = yield this.awsProvider.request("CloudFormation", "createChangeSet", params);
                this.serverless.cli.log("Waiting for change set creation to complete, this may take a minute...");
                utils_1.waitForStatus({
                    awsMethod: "describeChangeSet",
                    callbackMethod: () => this.executeChangeSet(Id, StackId),
                    methodParams: { ChangeSetName: Id },
                    statusPath: "Status"
                }, this);
            }
            catch (err) {
                this.serverless.cli.log("Unable to create newrelic-log-ingestion function. Please verify that required environment variables have been set.");
            }
        });
    }
    retrieveLicenseKey() {
        return __awaiter(this, void 0, void 0, function* () {
            const { apiKey, accountId } = this.config;
            const userData = yield api_1.nerdgraphFetch(apiKey, this.region, api_1.fetchLicenseKey(accountId));
            this.licenseKey = _.get(userData, "data.actor.account.licenseKey", null);
            return this.licenseKey;
        });
    }
    formatFunctionVariables() {
        return __awaiter(this, void 0, void 0, function* () {
            const { logEnabled } = this.config;
            const licenseKey = this.licenseKey
                ? this.licenseKey
                : yield this.retrieveLicenseKey();
            const loggingVar = logEnabled ? "True" : "False";
            return [
                {
                    ParameterKey: "NRLoggingEnabled",
                    ParameterValue: `${loggingVar}`
                },
                {
                    ParameterKey: "NRLicenseKey",
                    ParameterValue: `${licenseKey}`
                }
            ];
        });
    }
    getSarTemplate() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = yield this.awsProvider.request("ServerlessApplicationRepository", "createCloudFormationTemplate", {
                    ApplicationId: "arn:aws:serverlessrepo:us-east-1:463657938898:applications/NewRelic-log-ingestion"
                });
                const { TemplateUrl } = data;
                return TemplateUrl;
            }
            catch (err) {
                this.serverless.cli.log(`Something went wrong while fetching the sar template: ${err}`);
            }
        });
    }
    executeChangeSet(changeSetName, stackId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.awsProvider.request("CloudFormation", "executeChangeSet", {
                    ChangeSetName: changeSetName
                });
                this.serverless.cli.log("Waiting for newrelic-log-ingestion install to complete, this may take a minute...");
                utils_1.waitForStatus({
                    awsMethod: "describeStacks",
                    callbackMethod: () => this.addLogSubscriptions(),
                    methodParams: { StackName: stackId },
                    statusPath: "Stacks[0].StackStatus"
                }, this);
            }
            catch (changeSetErr) {
                this.serverless.cli.log(`Something went wrong while executing the change set: ${changeSetErr}`);
            }
        });
    }
    describeSubscriptionFilters(funcName) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.awsProvider
                .request("CloudWatchLogs", "describeSubscriptionFilters", {
                logGroupName: `/aws/lambda/${funcName}`
            })
                .then(res => res.subscriptionFilters);
        });
    }
    addSubscriptionFilter(funcName, destinationArn, cloudWatchFilterString) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.awsProvider
                .request("CloudWatchLogs", "putSubscriptionFilter", {
                destinationArn,
                filterName: "NewRelicLogStreaming",
                filterPattern: cloudWatchFilterString,
                logGroupName: `/aws/lambda/${funcName}`
            })
                .catch(err => {
                if (err.providerError) {
                    this.serverless.cli.log(err.providerError.message);
                }
            });
        });
    }
    removeSubscriptionFilter(funcName) {
        return this.awsProvider
            .request("CloudWatchLogs", "DeleteSubscriptionFilter", {
            filterName: "NewRelicLogStreaming",
            logGroupName: `/aws/lambda/${funcName}`
        })
            .catch(err => {
            if (err.providerError) {
                this.serverless.cli.log(err.providerError.message);
            }
        });
    }
}
exports.default = NewRelicLambdaLayerPlugin;
module.exports = NewRelicLambdaLayerPlugin;
