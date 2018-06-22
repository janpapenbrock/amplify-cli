import { Transformer, TransformerContext } from 'graphql-transform'
import {
    DirectiveNode, buildASTSchema, printSchema, ObjectTypeDefinitionNode
} from 'graphql'
import { ResourceFactory } from './resources'
import {
    makeCreateInputObject, makeUpdateInputObject, makeDeleteInputObject
} from './definitions'
import {
    blankObject, makeField, makeArg, makeNamedType,
    makeNonNullType, makeSchema, makeOperationType, blankObjectExtension,
    extensionWithFields, ResourceConstants
} from 'appsync-transformer-common'

interface QueryNameMap {
    get?: string
}

interface MutationNameMap {
    create?: string;
    update?: string;
    delete?: string;
}

interface ModelDirectiveArgs {
    queries?: QueryNameMap,
    mutations?: MutationNameMap
}

/**
 * The simple transform.
 *
 * This transform creates a single DynamoDB table for all of your application's
 * data. It uses a standard key structure and nested map to store object values.
 * A relationKey field
 *
 * {
 *  type (HASH),
 *  id (SORT),
 *  value (MAP),
 *  createdAt, (LSI w/ type)
 *  updatedAt (LSI w/ type)
 * }
 */
export class AppSyncDynamoDBTransformer extends Transformer {

    resources: ResourceFactory

    constructor() {
        super(
            'AppSyncDynamoDBTransformer',
            `directive @model(queries: DynamoDBQueryMap, mutations: DynamoDBMutationMap) on OBJECT`,
            `
                input DynamoDBMutationMap { create: String, update: String, delete: String }
                input DynamoDBQueryMap { get: String }
            `
        )
        this.resources = new ResourceFactory();
    }

    public before = (ctx: TransformerContext): void => {
        const template = this.resources.initTemplate();
        ctx.mergeResources(template.Resources)
        ctx.mergeParameters(template.Parameters)
        ctx.mergeOutputs(template.Outputs)
        const queryType = blankObject('Query')
        const mutationType = blankObject('Mutation')
        ctx.addObject(mutationType)
        ctx.addObject(queryType)
        const schema = makeSchema([
            makeOperationType('query', 'Query'),
            makeOperationType('mutation', 'Mutation')
        ])
        ctx.addSchema(schema)

        // Some downstream resources depend on this so put a placeholder in and
        // overwrite it in the after
        const schemaResource = this.resources.makeAppSyncSchema('placeholder')
        ctx.setResource(ResourceConstants.RESOURCES.GraphQLSchemaLogicalID, schemaResource)
    }

    public after = (ctx: TransformerContext): void => {
        const built = buildASTSchema({
            kind: 'Document',
            definitions: Object.keys(ctx.nodeMap).map((k: string) => ctx.nodeMap[k])
        })
        const SDL = printSchema(built)
        const schemaResource = this.resources.makeAppSyncSchema(SDL)
        ctx.setResource(ResourceConstants.RESOURCES.GraphQLSchemaLogicalID, schemaResource)
    }

    /**
     * Given the initial input and context manipulate the context to handle this object directive.
     * @param initial The input passed to the transform.
     * @param ctx The accumulated context for the transform.
     */
    public object = (def: ObjectTypeDefinitionNode, directive: DirectiveNode, ctx: TransformerContext): void => {
        // Create the object type.
        ctx.addObject(def)

        // Create the input types.
        const createInput = makeCreateInputObject(def)
        const updateInput = makeUpdateInputObject(def)
        const deleteInput = makeDeleteInputObject(def)
        ctx.addInput(createInput)
        ctx.addInput(updateInput)
        ctx.addInput(deleteInput)

        // Create the mutation & query extension
        let mutationType = blankObjectExtension('Mutation')
        let queryType = blankObjectExtension('Query')

        // Get any name overrides provided by the user. If an empty map it provided
        // then we do not generate those fields.
        const directiveArguments: ModelDirectiveArgs = super.getDirectiveArgumentMap(directive)

        let shouldMakeCreate = true;
        let shouldMakeUpdate = true;
        let shouldMakeDelete = true;
        let shouldMakeGet = true;
        let createFieldNameOverride = undefined;
        let updateFieldNameOverride = undefined;
        let deleteFieldNameOverride = undefined;
        let getFieldNameOverride = undefined;

        // Figure out which queries to make and if they have name overrides.
        if (directiveArguments.queries) {
            if (!directiveArguments.queries.get) {
                shouldMakeGet = false;
            } else {
                getFieldNameOverride = directiveArguments.queries.get
            }
        }

        // Figure out which mutations to make and if they have name overrides
        if (directiveArguments.mutations) {
            if (!directiveArguments.mutations.create) {
                shouldMakeCreate = false;
            } else {
                createFieldNameOverride = directiveArguments.mutations.create
            }
            if (!directiveArguments.mutations.update) {
                shouldMakeUpdate = false;
            } else {
                updateFieldNameOverride = directiveArguments.mutations.update
            }
            if (!directiveArguments.mutations.delete) {
                shouldMakeDelete = false;
            } else {
                deleteFieldNameOverride = directiveArguments.mutations.delete
            }
        }

        const queryNameMap: QueryNameMap = directiveArguments.queries
        const mutationNameMap: MutationNameMap = directiveArguments.mutations

        // Create the mutations.
        if (shouldMakeCreate) {
            const createResolver = this.resources.makeCreateResolver(def.name.value, createFieldNameOverride)
            ctx.setResource(`Create${def.name.value}Resolver`, createResolver)
            mutationType = extensionWithFields(
                mutationType,
                [makeField(
                    createResolver.Properties.FieldName,
                    [makeArg('input', makeNonNullType(makeNamedType(createInput.name.value)))],
                    makeNamedType(def.name.value)
                )]
            )
        }

        if (shouldMakeUpdate) {
            const updateResolver = this.resources.makeUpdateResolver(def.name.value, updateFieldNameOverride)
            ctx.setResource(`Update${def.name.value}Resolver`, updateResolver)
            mutationType = extensionWithFields(
                mutationType,
                [makeField(
                    updateResolver.Properties.FieldName,
                    [makeArg('input', makeNonNullType(makeNamedType(updateInput.name.value)))],
                    makeNamedType(def.name.value)
                )]
            )
        }

        if (shouldMakeDelete) {
            const deleteResolver = this.resources.makeDeleteResolver(def.name.value, deleteFieldNameOverride)
            ctx.setResource(`Delete${def.name.value}Resolver`, deleteResolver)
            mutationType = extensionWithFields(
                mutationType,
                [makeField(
                    deleteResolver.Properties.FieldName,
                    [makeArg('input', makeNonNullType(makeNamedType(deleteInput.name.value)))],
                    makeNamedType(def.name.value)
                )]
            )
        }
        ctx.addObjectExtension(mutationType)

        // Create the queries
        if (shouldMakeGet) {
            const getResolver = this.resources.makeGetResolver(def.name.value, getFieldNameOverride)
            ctx.setResource(`Get${def.name.value}Resolver`, getResolver)
            queryType = extensionWithFields(
                queryType,
                [makeField(
                    getResolver.Properties.FieldName,
                    [makeArg('id', makeNonNullType(makeNamedType('ID')))],
                    makeNamedType(def.name.value)
                )]
            )
        }
        ctx.addObjectExtension(queryType)
    }
}
