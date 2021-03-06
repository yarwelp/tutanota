//@flow
import {_TypeModel as MailModel} from "../../entities/tutanota/Mail"
import {_TypeModel as ContactModel} from "../../entities/tutanota/Contact"
import {SearchIndexOS, ElementIdToIndexDataOS} from "./DbFacade"
import {TypeRef} from "../../common/EntityFunctions"
import {tokenize} from "./Tokenizer"
import {arrayEquals} from "../../common/utils/ArrayUtils"
import {neverNull} from "../../common/utils/Utils"
import type {
	KeyToEncryptedIndexEntries,
	EncryptedSearchIndexEntry,
	KeyToIndexEntries,
	IndexData,
	SearchIndexEntry
} from "./SearchTypes"
import {encryptIndexKey, decryptSearchIndexEntry} from "./IndexUtils"
import type {Indexer} from "./Indexer"

export class SearchFacade {
	_indexer: Indexer;

	constructor(indexer: Indexer) {
		this._indexer = indexer
	}

	/****************************** SEARCH ******************************/

	/**
	 * Invoke an AND-query.
	 * @param query is tokenized. All tokens must be matched by the result (AND-query)
	 * @param type
	 * @param attributes
	 * @returns {Promise.<U>|Promise.<SearchResult>}
	 */
	search(query: string, restriction: ?SearchRestriction): Promise<SearchResult> {
		let searchTokens = tokenize(query)
		return this._indexer.mailboxIndexingPromise.then(() => this._findIndexEntries(searchTokens)
				.then(results => this._filterByEncryptedId(results))
				.then(results => this._decryptSearchResult(results))
				.then(results => this._filterByAttributeId(results, restriction))
				.then(results => this._groupSearchResults(query, restriction, results))
			// ranking ->all tokens are in correct order in the same attribute
		)
	}

	_findIndexEntries(searchTokens: string[]): Promise<KeyToEncryptedIndexEntries[]> {
		let transaction = this._indexer.db.dbFacade.createTransaction(true, [SearchIndexOS])
		return Promise.map(searchTokens, (token) => {
			let indexKey = encryptIndexKey(this._indexer.db.key, token)
			return transaction.getAsList(SearchIndexOS, indexKey).then((indexEntries: EncryptedSearchIndexEntry[]) => {
				return {indexKey, indexEntries}
			})
		})
	}

	/**
	 * Reduces the search result by filtering out all mailIds that don't match all search tokens
	 */
	_filterByEncryptedId(results: KeyToEncryptedIndexEntries[]): KeyToEncryptedIndexEntries[] {
		let matchingEncIds = null
		results.forEach(keyToEncryptedIndexEntry => {
			if (matchingEncIds == null) {
				matchingEncIds = keyToEncryptedIndexEntry.indexEntries.map(entry => entry[0])
			} else {
				matchingEncIds = matchingEncIds.filter((encId) => {
					return keyToEncryptedIndexEntry.indexEntries.find(entry => arrayEquals(entry[0], encId))
				})
			}
		})
		return results.map(r => {
			return {
				indexKey: r.indexKey,
				indexEntries: r.indexEntries.filter(entry => neverNull(matchingEncIds).find(encId => arrayEquals(entry[0], encId)))
			}
		})
	}


	_decryptSearchResult(results: KeyToEncryptedIndexEntries[]): KeyToIndexEntries[] {
		return results.map(searchResult => {
			return {
				indexKey: searchResult.indexKey,
				indexEntries: searchResult.indexEntries.map(entry => decryptSearchIndexEntry(this._indexer.db.key, entry))
			}
		})
	}


	_filterByAttributeId(results: KeyToIndexEntries[], restriction: ?SearchRestriction): SearchIndexEntry[] {
		let indexEntries = null
		results.forEach(r => {
			if (indexEntries == null) {
				indexEntries = r.indexEntries.filter(entry => {
					return this._isIncluded(restriction, entry)
				})
			} else {
				indexEntries = indexEntries.filter(e1 => {
					return r.indexEntries.find(e2 => e1.id != e2.id ? false : true) != null
				})
			}
		})
		if (indexEntries) {
			return indexEntries
		} else {
			return []
		}
	}

	_isIncluded(restriction: ?SearchRestriction, entry: SearchIndexEntry) {
		if (restriction) {
			let typeInfo = typeRefToTypeInfo(restriction.type)
			if (typeInfo.appId != entry.app || typeInfo.typeId != entry.type) {
				return false
			}
			if (restriction.attributes.length > 0) {
				for (let a of restriction.attributes) {
					if (typeInfo.attributeIds.indexOf(Number(a)) === -1) {
						return false
					}
				}
			}
		}
		return true
	}

	_groupSearchResults(query: string, restriction: ?SearchRestriction, results: SearchIndexEntry[]): Promise<SearchResult> {
		let uniqueIds = {}
		return Promise.reduce(results, (searchResult, entry: SearchIndexEntry, index) => {
			//console.log(entry)
			let transaction = this._indexer.db.dbFacade.createTransaction(true, [ElementIdToIndexDataOS])
			return transaction.get(ElementIdToIndexDataOS, neverNull(entry.encId)).then((indexData: IndexData) => {
				let safeSearchResult = neverNull(searchResult)
				if (!uniqueIds[entry.id]) {
					uniqueIds[entry.id] = true
					if (entry.type == MailModel.id) {
						safeSearchResult.mails.push([indexData[0], entry.id])
					} else if (entry.type == ContactModel.id) {
						safeSearchResult.contacts.push([indexData[0], entry.id])
					}
				}
				return searchResult
			})
		}, {query, restriction, mails: [], contacts: []})
	}

}


type TypeInfo ={
	appId: number;
	typeId: number;
	attributeIds: number[];
}

const typeInfos = {
	"tutanota|Mail": {
		appId: 1,
		typeId: MailModel.id,
		attributeIds: getAttributeIds(MailModel)
	},
	"tutanota|Contact": {
		appId: 1,
		typeId: ContactModel.id,
		attributeIds: getAttributeIds(ContactModel)
	}
}

function typeRefToTypeInfo(typeRef: TypeRef<any>): TypeInfo {
	return typeInfos[typeRef.app + "|" + typeRef.type]
}

function getAttributeIds(model: TypeModel) {
	return Object.keys(model.values).map(name => model.values[name].id).concat(Object.keys(model.associations).map(name => model.associations[name].id))
}