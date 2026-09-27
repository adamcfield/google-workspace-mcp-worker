/**
 * Google Contacts tools (People API — the user's personal contacts + contact groups).
 * API: https://people.googleapis.com/v1
 */
import { z } from "zod";
import { API } from "../google/client.js";
import { tool, listResult, PageSize, PageToken, audit, type AnyRec } from "./_shared.js";

const SCOPE = "https://www.googleapis.com/auth/contacts";
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,urls,memberships,metadata,nicknames,relations,events";

const ResourceName = z.string().describe("Contact resource name, e.g. 'people/c1234567890' (from contacts_search_contacts / contacts_list_contacts)");
const ValueWithType = z.union([z.string(), z.object({ value: z.string(), type: z.string().optional().describe("e.g. home, work, mobile, other") })]);
const Emails = z.array(ValueWithType).optional().describe("Email addresses: plain strings or {value, type?}");
const Phones = z.array(ValueWithType).optional().describe("Phone numbers: plain strings or {value, type?}");
const Organization = z.object({ name: z.string().optional(), title: z.string().optional(), department: z.string().optional() }).optional().describe("Company / job title / department");
const Addresses = z
  .array(z.object({ street: z.string().optional(), city: z.string().optional(), region: z.string().optional(), postal_code: z.string().optional(), country: z.string().optional(), type: z.string().optional() }))
  .optional()
  .describe("Postal addresses (type e.g. home, work)");
const Birthday = z.string().optional().describe("YYYY-MM-DD or MM-DD (no year)");
const Urls = z.array(z.string()).optional().describe("Websites / profile URLs");

/** Fields shared by contacts_create_contact and contacts_update_contact. */
const PersonInput = {
  given_name: z.string().optional().describe("First name"),
  family_name: z.string().optional().describe("Last name"),
  emails: Emails,
  phones: Phones,
  organization: Organization,
  notes: z.string().optional().describe("Free-text notes (biography)"),
  addresses: Addresses,
  birthday: Birthday,
  urls: Urls,
  nickname: z.string().optional(),
};
type PersonArgs = z.infer<z.ZodObject<typeof PersonInput>>;

function formatDate(d: AnyRec | undefined): string | undefined {
  if (!d || !d.month || !d.day) return undefined;
  const mmdd = `${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return d.year ? `${d.year}-${mmdd}` : mmdd;
}

function parseBirthday(s: string): AnyRec {
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (full) return { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
  const noYear = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (noYear) return { month: Number(noYear[1]), day: Number(noYear[2]) };
  throw new Error(`Invalid birthday '${s}' — use YYYY-MM-DD or MM-DD`);
}

/** Person → compact shape. */
function compactPerson(p: AnyRec | undefined): AnyRec | undefined {
  if (!p) return undefined;
  const name = p.names?.[0];
  const org = p.organizations?.[0];
  return {
    resourceName: p.resourceName,
    etag: p.etag,
    name: name?.displayName,
    givenName: name?.givenName,
    familyName: name?.familyName,
    emails: (p.emailAddresses ?? []).map((e: AnyRec) => ({ value: e.value, type: e.type, primary: e.metadata?.primary || undefined })),
    phones: (p.phoneNumbers ?? []).map((n: AnyRec) => ({ value: n.value, type: n.type, primary: n.metadata?.primary || undefined })),
    organization: org ? { name: org.name, title: org.title, department: org.department } : undefined,
    addresses: (p.addresses ?? []).map((x: AnyRec) => ({ formattedValue: x.formattedValue, type: x.type })),
    birthday: formatDate(p.birthdays?.[0]?.date),
    notes: p.biographies?.[0]?.value,
    urls: (p.urls ?? []).map((u: AnyRec) => u.value),
    nickname: p.nicknames?.[0]?.value,
    groups: (p.memberships ?? []).map((m: AnyRec) => m.contactGroupMembership?.contactGroupResourceName).filter(Boolean),
    updated: p.metadata?.sources?.[0]?.updateTime,
  };
}

const toValues = (list: Array<string | { value: string; type?: string }>) => list.map((v) => (typeof v === "string" ? { value: v } : { value: v.value, type: v.type }));

/**
 * Build a partial Person body from the tool args. Returns the body plus the list
 * of Person fields it sets (for updatePersonFields). Only provided args are included.
 */
function buildPerson(a: PersonArgs): { body: AnyRec; fields: string[] } {
  const body: AnyRec = {};
  const fields: string[] = [];
  if (a.given_name !== undefined || a.family_name !== undefined) {
    body.names = [{ givenName: a.given_name, familyName: a.family_name }];
    fields.push("names");
  }
  if (a.emails) {
    body.emailAddresses = toValues(a.emails);
    fields.push("emailAddresses");
  }
  if (a.phones) {
    body.phoneNumbers = toValues(a.phones);
    fields.push("phoneNumbers");
  }
  if (a.organization) {
    body.organizations = [{ name: a.organization.name, title: a.organization.title, department: a.organization.department }];
    fields.push("organizations");
  }
  if (a.notes !== undefined) {
    body.biographies = [{ value: a.notes, contentType: "TEXT_PLAIN" }];
    fields.push("biographies");
  }
  if (a.addresses) {
    body.addresses = a.addresses.map((x) => ({ streetAddress: x.street, city: x.city, region: x.region, postalCode: x.postal_code, country: x.country, type: x.type }));
    fields.push("addresses");
  }
  if (a.birthday !== undefined) {
    body.birthdays = [{ date: parseBirthday(a.birthday) }];
    fields.push("birthdays");
  }
  if (a.urls) {
    body.urls = a.urls.map((u) => ({ value: u }));
    fields.push("urls");
  }
  if (a.nickname !== undefined) {
    body.nicknames = [{ value: a.nickname }];
    fields.push("nicknames");
  }
  return { body, fields };
}

export const contactsTools = [
  tool({
    name: "contacts_search_contacts",
    description:
      "Search the user's contacts by name, email, phone, nickname or organization (prefix match on words). Returns compact people with resourceName ('people/c…'), name, emails, phones, organization, groups. Max 30 results; use contacts_list_contacts to page through everything.",
    scope: SCOPE,
    input: {
      query: z.string().min(1).describe("Search text, e.g. 'John', 'john@', '+972'"),
      page_size: PageSize(10, 30),
    },
    handler: async (a, { g }) => {
      const url = `${API.people}/people:searchContacts`;
      // Google requires a warmup request (empty query) before searching so the cache is primed.
      await g.get(url, { query: "", readMask: PERSON_FIELDS, pageSize: 1 }).catch(() => {});
      const r = await g.get<AnyRec>(url, { query: a.query, readMask: PERSON_FIELDS, pageSize: a.page_size });
      return listResult((r.results ?? []).map((x: AnyRec) => compactPerson(x.person)));
    },
  }),

  tool({
    name: "contacts_list_contacts",
    description: "List all of the user's contacts (people/me/connections), paginated. Returns compact people plus totalPeople.",
    scope: SCOPE,
    input: {
      page_size: PageSize(100, 1000),
      page_token: PageToken,
      sort_order: z.enum(["LAST_MODIFIED_DESCENDING", "LAST_MODIFIED_ASCENDING", "FIRST_NAME_ASCENDING", "LAST_NAME_ASCENDING"]).default("LAST_MODIFIED_DESCENDING"),
    },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.people}/people/me/connections`, {
        personFields: PERSON_FIELDS,
        pageSize: a.page_size,
        pageToken: a.page_token,
        sortOrder: a.sort_order,
      });
      return listResult((r.connections ?? []).map((p: AnyRec) => compactPerson(p)), r.nextPageToken, { totalPeople: r.totalPeople });
    },
  }),

  tool({
    name: "contacts_get_contact",
    description: "Get one contact by resource name ('people/c…') with all supported fields (names, emails, phones, organization, addresses, birthday, notes, urls, nickname, groups).",
    scope: SCOPE,
    input: { resource_name: ResourceName },
    handler: async (a, { g }) => {
      if (!a.resource_name.startsWith("people/")) throw new Error(`resource_name must look like 'people/c123…' (got '${a.resource_name}')`);
      const r = await g.get<AnyRec>(`${API.people}/${a.resource_name}`, { personFields: PERSON_FIELDS });
      return compactPerson(r);
    },
  }),

  tool({
    name: "contacts_create_contact",
    description: "Create a contact. Requires at least a name, an email or a phone. emails/phones accept plain strings or {value, type} (type: home, work, mobile, other…). Returns the compact contact incl. its new resourceName.",
    scope: SCOPE,
    write: true,
    destructive: false,
    input: PersonInput,
    handler: async (a, { g }) => {
      const { body } = buildPerson(a);
      if (!body.names && !body.emailAddresses?.length && !body.phoneNumbers?.length) throw new Error("Provide at least a given_name/family_name, an email or a phone number");
      const r = await g.post<AnyRec>(`${API.people}/people:createContact`, body, { personFields: PERSON_FIELDS });
      audit("contacts_create_contact", { resourceName: r.resourceName });
      return compactPerson(r);
    },
  }),

  tool({
    name: "contacts_update_contact",
    description:
      "Update a contact. Each provided field REPLACES that whole field list on the contact (e.g. passing emails=[…] replaces all emails; omitted fields are untouched). given_name/family_name merge with the current name. Fetches the current etag automatically.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: { resource_name: ResourceName, ...PersonInput },
    handler: async (a, { g }) => {
      if (!a.resource_name.startsWith("people/")) throw new Error(`resource_name must look like 'people/c123…' (got '${a.resource_name}')`);
      const { body, fields } = buildPerson(a);
      if (!fields.length) throw new Error("Nothing to update — provide at least one field (given_name, family_name, emails, phones, organization, notes, addresses, birthday, urls, nickname)");
      const current = await g.get<AnyRec>(`${API.people}/${a.resource_name}`, { personFields: "names,metadata" });
      if (body.names) {
        const cur = current.names?.[0] ?? {};
        body.names = [{ givenName: a.given_name ?? cur.givenName, familyName: a.family_name ?? cur.familyName }];
      }
      const r = await g.patch<AnyRec>(`${API.people}/${a.resource_name}:updateContact`, { etag: current.etag, ...body }, { updatePersonFields: fields.join(","), personFields: PERSON_FIELDS });
      audit("contacts_update_contact", { resourceName: a.resource_name, fields });
      return compactPerson(r);
    },
  }),

  tool({
    name: "contacts_delete_contact",
    description: "Permanently delete a contact by resource name ('people/c…'). Irreversible.",
    scope: SCOPE,
    write: true,
    destructive: true,
    idempotent: true,
    input: { resource_name: ResourceName },
    handler: async (a, { g }) => {
      if (!a.resource_name.startsWith("people/")) throw new Error(`resource_name must look like 'people/c123…' (got '${a.resource_name}')`);
      await g.delete(`${API.people}/${a.resource_name}:deleteContact`);
      audit("contacts_delete_contact", { resourceName: a.resource_name });
      return { deleted: true, resourceName: a.resource_name };
    },
  }),

  tool({
    name: "contacts_list_groups",
    description: "List contact groups (labels): resourceName ('contactGroups/…'), name, groupType (USER_CONTACT_GROUP or SYSTEM_CONTACT_GROUP such as myContacts/starred), memberCount.",
    scope: SCOPE,
    input: {},
    handler: async (_a, { g }) => {
      const r = await g.get<AnyRec>(`${API.people}/contactGroups`, { groupFields: "name,groupType,memberCount", pageSize: 1000 });
      const items = (r.contactGroups ?? []).map((c: AnyRec) => ({ resourceName: c.resourceName, name: c.name, groupType: c.groupType, memberCount: c.memberCount }));
      return listResult(items, r.nextPageToken);
    },
  }),

  tool({
    name: "contacts_modify_group_members",
    description: "Add and/or remove contacts ('people/c…') in a contact group ('contactGroups/…'). System groups (myContacts, starred…) cannot be modified this way except starred.",
    scope: SCOPE,
    write: true,
    idempotent: true,
    input: {
      group_resource_name: z.string().describe("Group resource name, e.g. 'contactGroups/1a2b3c' (from contacts_list_groups)"),
      add: z.array(z.string()).optional().describe("Contact resource names to add"),
      remove: z.array(z.string()).optional().describe("Contact resource names to remove"),
    },
    handler: async (a, { g }) => {
      if (!a.group_resource_name.startsWith("contactGroups/")) throw new Error(`group_resource_name must look like 'contactGroups/…' (got '${a.group_resource_name}')`);
      if (!a.add?.length && !a.remove?.length) throw new Error("Provide at least one resource name in add or remove");
      const r = await g.post<AnyRec>(`${API.people}/${a.group_resource_name}/members:modify`, { resourceNamesToAdd: a.add ?? [], resourceNamesToRemove: a.remove ?? [] });
      audit("contacts_modify_group_members", { group: a.group_resource_name, added: a.add?.length ?? 0, removed: a.remove?.length ?? 0 });
      return { group: a.group_resource_name, added: a.add ?? [], removed: a.remove ?? [], notFound: r.notFoundResourceNames ?? [], cannotRemoveLastContactGroup: r.canNotRemoveLastContactGroupResourceNames ?? [] };
    },
  }),

  tool({
    name: "contacts_batch_get_contacts",
    description: "Get up to 200 contacts by resource name ('people/c…') in one call. Missing/inaccessible ones are reported in `errors`.",
    scope: SCOPE,
    input: { resource_names: z.array(z.string()).min(1).max(200) },
    handler: async (a, { g }) => {
      const r = await g.get<AnyRec>(`${API.people}/people:batchGet`, { resourceNames: a.resource_names, personFields: PERSON_FIELDS });
      const responses: AnyRec[] = r.responses ?? [];
      const items = responses.filter((x) => x.person).map((x) => compactPerson(x.person));
      const errors = responses.filter((x) => !x.person).map((x) => ({ resourceName: x.requestedResourceName, status: x.status }));
      return listResult(items, undefined, { errors });
    },
  }),
];
