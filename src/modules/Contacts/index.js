import RcModule from '../../lib/RcModule';
import isBlank from '../../lib/isBlank';
import normalizeNumber from '../../lib/normalizeNumber';
import ensureExist from '../../lib/ensureExist';
import { batchGetApi } from '../../lib/batchApiHelper';
import actionTypes from './actionTypes';
import getContactsReducer from './getContactsReducer';

const MaximumBatchGetPresence = 30;

function addPhoneToContact(contact, phone, type) {
  const phoneNumber = normalizeNumber({ phoneNumber: phone });
  if (isBlank(phoneNumber)) {
    return;
  }
  const existedPhone = contact.phoneNumbers.find(
    number => number && number.phoneNumber === phone
  );
  if (existedPhone) {
    existedPhone.phoneType = type;
  } else {
    contact.phoneNumbers.push({
      phoneNumber: phone,
      phoneType: type,
    });
  }
}

const DEFAULT_TTL = 30 * 60 * 1000; // 30 mins
const DEFAULT_PRESENCETTL = 10 * 60 * 1000; // 5 mins
const DEFAULT_AVATARTTL = 2 * 60 * 60 * 1000; // 2 hour

/**
 * @class
 * @description Contacts managing module
 */
export default class Contacts extends RcModule {
  /**
   * @constructor
   * @param {Object} params - params object
   * @param {Client} params.client - client module instance
   * @param {AddressBook} params.addressBook - addressBook module instance
   * @param {AccountExtension} params.accountExtension - accountExtension module instance
   * @param {AccountPhoneNumber} params.accountPhoneNumber - accountPhoneNumber module instance
   * @param {Number} params.ttl - timestamp of local cache, default 30 mins
   * @param {Number} params.avatarTtl - timestamp of avatar local cache, default 2 hour
   * @param {Number} params.presenceTtl - timestamp of presence local cache, default 10 mins
   */
  constructor({
    client,
    addressBook,
    accountExtension,
    accountPhoneNumber,
    ttl = DEFAULT_TTL,
    avatarTtl = DEFAULT_AVATARTTL,
    presenceTtl = DEFAULT_PRESENCETTL,
    ...options,
  }) {
    super({
      ...options,
      actionTypes,
    });
    this._addressBook = this::ensureExist(addressBook, 'addressBook');
    this._accountExtension = this::ensureExist(accountExtension, 'accountExtension');
    this._accountPhoneNumber = this::ensureExist(accountPhoneNumber, 'accountPhoneNumber');
    this._client = this::ensureExist(client, 'client');
    this._reducer = getContactsReducer(this.actionTypes);
    this._ttl = ttl;
    this._avatarTtl = avatarTtl;
    this._presenceTtl = presenceTtl;

    this.addSelector(
      'companyContacts',
      () => this._accountExtension.availableExtensions,
      () => this._accountPhoneNumber.extensionToPhoneNumberMap,
      (extensions, extensionToPhoneNumberMap) => {
        const newExtensions = [];
        extensions.forEach((extension) => {
          if (!(extension.status === 'Enabled' &&
            ['DigitalUser', 'User'].indexOf(extension.type) >= 0)) {
            return;
          }
          const contact = {
            type: 'company',
            id: extension.id,
            firstName: extension.contact && extension.contact.firstName,
            lastName: extension.contact && extension.contact.lastName,
            email: extension.contact && extension.contact.email,
            extensionNumber: extension.ext,
            hasProfileImage: extension.hasProfileImage,
            phoneNumbers: [],
          };
          if (isBlank(contact.extensionNumber)) {
            return;
          }
          const phones = extensionToPhoneNumberMap[contact.extensionNumber];
          if (phones && phones.length > 0) {
            phones.forEach((phone) => {
              addPhoneToContact(contact, phone.phoneNumber, 'directPhone');
            });
          }
          newExtensions.push(contact);
        });
        return newExtensions;
      }
    );

    this.addSelector(
      'personalContacts',
      () => this._addressBook.contacts,
      (rawContacts) => {
        const contacts = [];
        rawContacts.forEach((rawContact) => {
          const contact = {
            type: 'personal',
            phoneNumbers: [],
            ...rawContact,
          };
          Object.keys(contact).forEach((key) => {
            if (key.toLowerCase().indexOf('phone') === -1) {
              return;
            }
            if (typeof contact[key] !== 'string') {
              return;
            }
            addPhoneToContact(contact, contact[key], key);
          });
          contacts.push(contact);
        });
        return contacts;
      }
    );
  }

  initialize() {
    this.store.subscribe(() => this._onStateChange());
  }

  _onStateChange() {
    if (this._shouldInit()) {
      this.store.dispatch({
        type: this.actionTypes.initSuccess,
      });
    } else if (this._shouldReset()) {
      this._resetModuleStatus();
    }
  }

  _shouldInit() {
    return (
      this._addressBook.ready &&
      this._accountExtension.ready &&
      this._accountPhoneNumber.ready &&
      this.pending
    );
  }

  _shouldReset() {
    return (
      (
        !this._addressBook.ready ||
        !this._accountExtension.ready ||
        !this._accountPhoneNumber.ready
      ) &&
      this.ready
    );
  }

  _resetModuleStatus() {
    this.store.dispatch({
      type: this.actionTypes.resetSuccess,
    });
  }

  matchPhoneNumber(phone) {
    const result = [];
    const phoneNumber = normalizeNumber({ phoneNumber: phone });
    const matchContact = (contact) => {
      let found = contact.extensionNumber && contact.extensionNumber === phoneNumber;
      if (!found) {
        contact.phoneNumbers.forEach((contactPhoneNumber) => {
          if (!found && contactPhoneNumber.phoneNumber === phoneNumber) {
            found = true;
          }
        });
      }
      if (!found) {
        return;
      }
      const name =
        `${
          contact.firstName ? contact.firstName : ''
        } ${
          contact.lastName ? contact.lastName : ''
        }`;
      const matchedContact = {
        ...contact,
        phoneNumbers: [
          ...contact.phoneNumbers
        ],
        entityType: 'rcContact',
        name,
      };
      if (contact.extensionNumber) {
        matchedContact.phoneNumbers.push({
          phoneType: 'extension',
          phoneNumber: contact.extensionNumber,
        });
      }
      result.push(matchedContact);
    };
    this.companyContacts.forEach(matchContact);
    this.personalContacts.forEach(matchContact);
    return result;
  }

  matchContacts({ phoneNumbers }) {
    const result = {};
    phoneNumbers.forEach((phoneNumber) => {
      result[phoneNumber] = this.matchPhoneNumber(phoneNumber);
    });
    return result;
  }

  async getImageProfile(contact) {
    if (contact.type === 'company' && contact.id && contact.hasProfileImage) {
      const imageId = `${contact.type}${contact.id}`;
      if (
        this.profileImages[imageId] &&
        (Date.now() - this.profileImages[imageId].timestamp < this._avatarTtl)
      ) {
        return this.profileImages[imageId].imageUrl;
      }
      try {
        const response = await this._client.account().extension(contact.id).profileImage().get();
        const imageUrl = URL.createObjectURL(await response._response.blob());
        this.store.dispatch({
          type: this.actionTypes.fetchImageSuccess,
          imageId,
          imageUrl,
          ttl: this._avatarTtl,
        });
        return imageUrl;
      } catch (e) {
        console.error(e);
        return null;
      }
    }
    return null;
  }

  getPresence(contact) {
    return new Promise((resolve) => {
      if (!contact || !contact.id || contact.type !== 'company') {
        resolve(null);
        return;
      }

      const presenceId = `${contact.type}${contact.id}`;
      if (
        this.contactPresences[presenceId] &&
        (Date.now() - this.contactPresences[presenceId].timestamp < this._presenceTtl)
      ) {
        const presence = this.contactPresences[presenceId].presence;
        resolve(presence);
        return;
      }

      if (!this._getPresenceContexts) {
        this._getPresenceContexts = [];
      }
      this._getPresenceContexts.push({
        contact,
        resolve,
      });

      clearTimeout(this.enqueueTimeoutId);
      if (this._getPresenceContexts.length === MaximumBatchGetPresence) {
        this._processQueryPresences(this._getPresenceContexts);
        this._getPresenceContexts = null;
      } else {
        this.enqueueTimeoutId = setTimeout(() => {
          this._processQueryPresences(this._getPresenceContexts);
          this._getPresenceContexts = null;
        }, 200);
      }
    });
  }

  async _processQueryPresences(getPresenceContexts) {
    const contacts = getPresenceContexts.map(x => x.contact);
    const responses = await this._batchQueryPresences(contacts);
    getPresenceContexts.forEach((ctx) => {
      const response = responses[ctx.contact.id];
      if (!response) {
        ctx.resolve(null);
        return;
      }
      const { dndStatus, presenceStatus, telephonyStatus, userStatus } = response;
      const presence = {
        dndStatus,
        presenceStatus,
        telephonyStatus,
        userStatus,
      };
      const presenceId = `${ctx.contact.type}${ctx.contact.id}`;
      this.store.dispatch({
        type: this.actionTypes.fetchPresenceSuccess,
        presenceId,
        presence,
        ttl: this._presenceTtl,
      });
      ctx.resolve(presence);
    });
  }

  async _batchQueryPresences(contacts) {
    const presenceSet = {};
    try {
      if (contacts.length === 1) {
        const id = contacts[0].id;
        const response = await this._client.account().extension(id).presence().get();
        presenceSet[id] = response;
      } else if (contacts.length > 1) {
        const ids = contacts.map(x => x.id).join(',');
        const multipartResponse = await batchGetApi({
          platform: this._client.service.platform(),
          url: `/account/~/extension/${ids}/presence?detailedTelephonyState=true&sipData=true`,
        });
        const responses = multipartResponse.map(x => x.json());
        responses.forEach((item) => {
          presenceSet[item.extension.id] = item;
        });
      }
    } catch (e) {
      console.error(e);
    }
    return presenceSet;
  }

  get status() {
    return this.state.status;
  }

  get companyContacts() {
    return this._selectors.companyContacts();
  }

  get personalContacts() {
    return this._selectors.personalContacts();
  }

  get profileImages() {
    return this.state.profileImages;
  }

  get contactPresences() {
    return this.state.contactPresences;
  }
}
