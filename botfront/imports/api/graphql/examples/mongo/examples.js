import shortid from 'shortid';
import { escapeRegExp, intersectionBy } from 'lodash';
import emojiTree from 'emoji-tree';
import Examples from '../examples.model.js';
import { setsAreIdentical } from '../../../../lib/utils';
import { canonicalizeExamples } from '../../../nlu_model/nlu_model.utils';

const checkNoEmojisInExamples = (example) => {
    if (emojiTree(example.text).some(c => c.type === 'emoji')) {
        throw new Meteor.Error('400', 'Emojis not allowed.');
    }
};

const createSortObject = (fieldName = 'intent', order = 'ASC') => {
    const orderMongo = order === 'ASC' ? 1 : -1;
    const sortObject = { 'metadata.draft': -1, [fieldName]: orderMongo };
    return { sort: sortObject };
};

const createFilterObject = (
    projectId,
    language,
    intents,
    entities = [],
    onlyCanonicals,
    text,
    options = {},
) => {
    const filters = { projectId };
    const { exactMatch } = options;
    filters['metadata.language'] = language;

    if (intents && intents.length > 0) {
        filters.intent = {
            $in: intents,
        };
    }
    if (!exactMatch && entities && entities.length > 0) {
        filters['entities.entity'] = {
            $in: entities,
        };
    }
    if (exactMatch) {
        // perfect match of entity payload if entities is array of { entity, value }
        filters.entities = { $size: entities.length };
        if (entities.length) {
            filters.entities.$all = entities.map(({ entity, value }) => ({
                $elemMatch: { entity, value },
            }));
        }
    }
    if (onlyCanonicals) {
        filters['metadata.canonical'] = true;
    }
    if (text && text.length > 0) {
        filters.text = { $regex: new RegExp(escapeRegExp(text), 'i') };
    }
    return filters;
};

export const getExamples = async ({
    projectId = '',
    pageSize = 20,
    language = '',
    intents = [],
    entities = [],
    text = '',
    onlyCanonicals = false,
    order = undefined,
    sortKey = undefined,
    cursor = undefined,
    options = {},
}) => {
    const filtersObject = createFilterObject(
        projectId,
        language,
        intents,
        entities,
        onlyCanonicals,
        text,
        options,
    );
    const sortObject = createSortObject(sortKey, order);
    const data = await Examples.find(filtersObject, null, sortObject).lean();

    const cursorIndex = !cursor
        ? 0
        : data.findIndex(activity => activity._id === cursor) + 1;
    const examples = pageSize === 0 ? data : data.slice(cursorIndex, cursorIndex + pageSize);

    return {
        examples,
        pageInfo: {
            endCursor: examples.length ? examples[examples.length - 1]._id : '',
            hasNextPage: cursorIndex + pageSize < data.length,
            totalLength: data.length,
        },
    };
};

export const listIntentsAndEntities = async ({ projectId, language }) => {
    const intents = {};
    let entities = [];
    const examples = await Examples.find({
        projectId,
        'metadata.language': language,
        intent: { $ne: null },
    })
        .select({
            intent: 1,
            entities: 1,
            text: 1,
            'metadata.canonical': 1,
        })
        .sort({ 'metadata.canonical': -1 })
        .lean();
    examples.forEach((ex) => {
        const exEntities = (ex.entities || []).map(en => en.entity);
        entities = entities.concat(exEntities.filter(en => !entities.includes(en)));
        if (!Object.keys(intents).includes(ex.intent)) intents[ex.intent] = [];
        if (
            !intents[ex.intent].some(ex2 => setsAreIdentical(ex2.entities, exEntities))
        ) {
            intents[ex.intent].push({ entities: exEntities, example: ex });
        }
    });

    return { intents, entities };
};

export const insertExamples = async ({
    examples, language, projectId, options = {},
}) => {
    if (!examples.length) return [];
    const { autoAssignCanonical = true, overwriteOnSameText = false } = options;
    let preparedExamples = examples.reduce((acc, curr) => {
        checkNoEmojisInExamples(curr);
        if (acc.some(ex => ex.text === curr.text)) return acc; // no duplicates
        return [
            ...acc,
            {
                ...curr,
                projectId,
                metadata: { ...(curr.metadata || {}), ...(language ? { language } : {}) },
                createdAt: new Date(),
                updatedAt: new Date(),
                _id: shortid.generate(),
            },
        ];
    }, []);
    const { examples: existingExamples } = await getExamples({
        projectId,
        pageSize: -1,
        language,
    });
    const itemsWithSameText = intersectionBy(
        existingExamples,
        preparedExamples,
        'text',
    ).map(({ text }) => text);
    if (autoAssignCanonical) {
        preparedExamples = canonicalizeExamples(preparedExamples, existingExamples);
    }
    if (!overwriteOnSameText) {
        preparedExamples = preparedExamples.filter(
            ({ text }) => !itemsWithSameText.includes(text),
        );
    }
    try {
        if (overwriteOnSameText) {
            await Examples.deleteMany({ text: { $in: itemsWithSameText } }).exec();
        }
        const result = await Examples.insertMany(preparedExamples);
        if (result.length !== preparedExamples.length) {
            throw new Error('Insert failed');
        }
        return preparedExamples;
    } catch (e) {
        return [];
    }
};

export const updateExamples = async ({ examples }) => {
    const updatesPromises = examples.map(async (example) => {
        checkNoEmojisInExamples(example);
        const result = await Examples.findOneAndUpdate(
            { _id: example._id },
            { $set: { ...example, updatedAt: new Date() } },
            { new: true }, // return the document after the update
        ).lean();
        if (!result) {
            throw new Error('Update failed');
        }
        return result;
    });
    const newExamples = await Promise.all(updatesPromises);
    return newExamples;
};

export const deleteExamples = async ({ ids }) => {
    const result = await Examples.deleteMany({ _id: { $in: ids } }).exec();
    if (result.deletedCount !== ids.length) {
        throw new Error('Issue during delete');
    }
    return ids;
};

export const switchCanonical = async ({ projectId, language, example }) => {
    if (!example.intent) return { change: null };
    if (example.metadata && !example.metadata.canonical) {
        /* try to match a canonical item with the same characteristics (intent, entity, entity value)
        to check if the selected item can be used as canonical
        */
        const entities = example.entities ? example.entities : [];
        let elemMatch = {
            'metadata.canonical': true,
            intent: example.intent,
            entities: { $size: entities.length },
        };

        if (entities.length > 0) {
            const entityElemMatchs = entities.map(entity => ({
                $elemMatch: { entity: entity.entity, value: entity.value },
            }));
            elemMatch = {
                ...elemMatch,
                $and: [
                    { entities: { $size: entities.length } },
                    { entities: { $all: entityElemMatchs } },
                ],
            };
            delete elemMatch.entities; // remove the entities field as the size condition is now in the $and
        }

        const query = {
            projectId,
            'metadata.language': language,
            ...elemMatch,
        };
        const result = await Examples.findOne(query).lean();
        const examplesToUpdate = [];
        if (result) {
            examplesToUpdate.push({
                ...result,
                metadata: { ...result.metadata, canonical: false },
            });
        }
        examplesToUpdate.push({
            ...example,
            metadata: { ...example.metadata, canonical: true },
        });
        return updateExamples({ examples: examplesToUpdate });
    }
    return updateExamples({
        examples: [{ ...example, metadata: { ...example.metadata, canonical: false } }],
    });
};