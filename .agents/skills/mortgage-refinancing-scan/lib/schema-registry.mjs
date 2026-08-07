import {readFileSync, readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SCHEMA_DIR = new URL("../schemas/", import.meta.url);
const SCHEMA_SUFFIX = ".schema.json";

/**
 * Name of the shared definition-only schema; it is registered for `$ref`
 * resolution but is not a validatable contract on its own.
 */
export const COMMON_SCHEMA_NAME = "common";

/** Error raised by `assertValidContract`. */
export class ContractValidationError extends Error {
    /**
     * @param {string} contract
     * @param {Array<object>} errors
     */
    constructor(contract, errors) {
        const detail = errors.map((error) => `${error.path} ${error.message}`).join("; ");
        super(`contract "${contract}" validation failed: ${detail}`);
        this.name = "ContractValidationError";
        this.contract = contract;
        this.errors = errors;
    }
}

const schemas = loadSchemas();
const ajv = createAjv(schemas);
const validators = new Map();

/** All registered schema names, including the shared definitions schema. */
export const SCHEMA_NAMES = Object.freeze([...schemas.keys()].sort());

/** All validatable contract names. */
export const CONTRACT_NAMES = Object.freeze(
    SCHEMA_NAMES.filter((name) => name !== COMMON_SCHEMA_NAME)
);

/**
 * @returns {string[]} validatable contract names
 */
export function listContractNames() {
    return [...CONTRACT_NAMES];
}

/**
 * @param {string} name
 * @returns {string} stable `$id` of the schema
 */
export function schemaId(name) {
    return requireSchema(name).$id;
}

/**
 * @param {string} name
 * @returns {object} raw schema document
 */
export function getSchema(name) {
    return requireSchema(name);
}

/**
 * Compiled Ajv validator for a contract; compiled once per process.
 *
 * @param {string} name
 * @returns {import("ajv").ValidateFunction}
 */
export function getValidator(name) {
    const cached = validators.get(name);
    if (cached) {
        return cached;
    }
    if (name === COMMON_SCHEMA_NAME) {
        throw new Error(`schema "${name}" holds shared definitions only and is not validatable`);
    }
    const validator = ajv.getSchema(schemaId(name));
    if (!validator) {
        throw new Error(`schema "${name}" is not registered`);
    }
    validators.set(name, validator);
    return validator;
}

/**
 * Compiles every contract validator; used as a startup/registry self check.
 *
 * @returns {string[]} compiled contract names
 */
export function compileAllContracts() {
    for (const name of CONTRACT_NAMES) {
        getValidator(name);
    }
    return listContractNames();
}

/**
 * Validates a value against one registered contract.
 *
 * @param {string} name contract name, e.g. `run-manifest`
 * @param {unknown} value
 * @param {{label?: string}} [options]
 * @returns {{valid: boolean, errors: Array<{code: string, message: string, path: string, keyword: string|null, contract: string}>}}
 */
export function validateContract(name, value, options = {}) {
    const validator = getValidator(name);
    const valid = validator(value);
    if (valid) {
        return {valid: true, errors: []};
    }
    const label = options.label ?? name;
    return {
        valid: false,
        errors: (validator.errors ?? []).map((error) => toContractError(label, error))
    };
}

/**
 * Validates a value and throws `ContractValidationError` when it is invalid.
 *
 * @param {string} name
 * @param {unknown} value
 * @param {{label?: string}} [options]
 * @returns {unknown} the validated value
 */
export function assertValidContract(name, value, options = {}) {
    const result = validateContract(name, value, options);
    if (!result.valid) {
        throw new ContractValidationError(options.label ?? name, result.errors);
    }
    return value;
}

function toContractError(contract, error) {
    const path = error.instancePath === "" ? "/" : error.instancePath;
    const params = error.params && Object.keys(error.params).length > 0
        ? ` (${JSON.stringify(error.params)})`
        : "";
    return {
        code: "schema_violation",
        contract,
        keyword: error.keyword ?? null,
        path,
        message: `${error.message ?? "is invalid"}${params}`
    };
}

function requireSchema(name) {
    const schema = schemas.get(name);
    if (!schema) {
        throw new Error(`schema "${name}" is not registered`);
    }
    return schema;
}

function loadSchemas() {
    const dir = fileURLToPath(SCHEMA_DIR);
    const files = readdirSync(dir)
        .filter((file) => file.endsWith(SCHEMA_SUFFIX))
        .sort();
    const loaded = new Map();
    for (const file of files) {
        const schema = JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), "utf8"));
        if (typeof schema.$id !== "string" || schema.$id.length === 0) {
            throw new Error(`schema file "${file}" has no stable $id`);
        }
        loaded.set(file.slice(0, -SCHEMA_SUFFIX.length), schema);
    }
    if (loaded.size === 0) {
        throw new Error("no contract schemas found");
    }
    return loaded;
}

function createAjv(loadedSchemas) {
    const instance = new Ajv2020({
        strict: true,
        allErrors: true,
        allowUnionTypes: true,
        validateFormats: true
    });
    addFormats(instance);
    for (const schema of loadedSchemas.values()) {
        instance.addSchema(schema);
    }
    return instance;
}
