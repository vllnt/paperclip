import { GitHubClient } from "./github.js";
import { choice, confirm, integer, strings, text, type Params } from "./management-repository.js";

export const projectWrites = new Set(["create", "edit", "delete", "add-item", "add-draft", "edit-draft", "convert-draft", "remove-item", "archive-item", "restore-item", "move-item", "set-field", "clear-field", "create-field", "edit-field", "delete-field", "link-repository", "unlink-repository"]);
export const projectReads = new Set(["list", "detail", "items"]);
const info = "id number title url shortDescription readme closed public";
const fieldInfo = `...on ProjectV2FieldCommon{id name dataType} ...on ProjectV2SingleSelectField{options{id name color description}} ...on ProjectV2IterationField{configuration{duration startDay iterations{id title startDate duration} completedIterations{id title startDate duration}}}`;
const itemInfo = `id type isArchived content{__typename ...on Issue{id fullDatabaseId number title body updatedAt stateReason issueState:state url assignees(first:100){nodes{login}} labels(first:100){nodes{name}} repository{nameWithOwner}} ...on PullRequest{id number title pullRequestState:state url repository{nameWithOwner}} ...on DraftIssue{id title body}}
fieldValues(first:100){nodes{...on ProjectV2ItemFieldTextValue{text field{...on ProjectV2FieldCommon{id name}}} ...on ProjectV2ItemFieldNumberValue{number field{...on ProjectV2FieldCommon{id name}}} ...on ProjectV2ItemFieldDateValue{date field{...on ProjectV2FieldCommon{id name}}} ...on ProjectV2ItemFieldSingleSelectValue{optionId name field{...on ProjectV2FieldCommon{id name}}} ...on ProjectV2ItemFieldIterationValue{iterationId title field{...on ProjectV2FieldCommon{id name}}}}}`;

/** All IDs used in a mutation are read back under the selected owner/project. */
export class ProjectManager {
  constructor(private github: GitHubClient, private token: string, private owner: { login: string; type: "Organization" | "User" }, private repoNode: (repositoryId: unknown, number?: unknown) => Promise<{ id: string; contentId?: string }>, private beforeWrite: () => Promise<void> = async () => {}) {}
  private query<T = any>(query: string, variables: Params = {}) { return this.github.graphql<T>(this.token, query, variables); }
  private async mutate(name: string, type: string, input: Params, selection = "clientMutationId") {
    await this.beforeWrite();
    return this.query(`mutation($input:${type}!){${name}(input:$input){${selection}}}`, { input });
  }
  private async project(number: unknown) {
    const data = await this.query(`query($login:String!,$number:Int!){${this.owner.type === "Organization" ? "organization" : "user"}(login:$login){projectV2(number:$number){${info}}}}`, { login: this.owner.login, number: integer(number, "project number") });
    const project = (data.organization ?? data.user)?.projectV2;
    if (!project) throw new Error("This project is unavailable for the selected account.");
    return project;
  }
  private async fields(id: string) {
    const fields: any[] = []; let cursor: string | null = null;
    do {
      const data: any = await this.query(`query($id:ID!,$cursor:String){node(id:$id){...on ProjectV2{fields(first:100,after:$cursor){nodes{${fieldInfo}} pageInfo{hasNextPage endCursor}}}}}`, { id, cursor });
      const page: any = data.node?.fields; if (!page) throw new Error("Project fields are unavailable.");
      fields.push(...page.nodes.filter(Boolean));
      const next: string | null = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (next && next === cursor) throw new Error("GitHub returned an invalid field cursor.");
      cursor = next;
    } while (cursor);
    return fields;
  }
  private async item(id: unknown, projectId: string) {
    const data = await this.query(`query($id:ID!){node(id:$id){...on ProjectV2Item{${itemInfo} project{id}}}}`, { id: text(id, "item", 200) });
    if (data.node?.project?.id !== projectId) throw new Error("This item does not belong to this project.");
    return data.node;
  }
  async run(op: string, p: Params) {
    if (op === "list" || op === "create") {
      const data = await this.query(`query($login:String!,$cursor:String){${this.owner.type === "Organization" ? "organization" : "user"}(login:$login){id projectsV2(first:50,after:$cursor){nodes{${info}} pageInfo{hasNextPage endCursor}}}}`, { login: this.owner.login, cursor: p.cursor == null ? null : text(p.cursor, "cursor", 1000) });
      const owner = data.organization ?? data.user;
      if (!owner) throw new Error("This GitHub account is unavailable.");
      if (op === "list") return { rows: owner.projectsV2.nodes, nextCursor: owner.projectsV2.pageInfo.hasNextPage ? owner.projectsV2.pageInfo.endCursor : null };
      return this.mutate("createProjectV2", "CreateProjectV2Input", { ownerId: owner.id, title: text(p.title, "project title", 256) }, `projectV2{${info}}`);
    }
    const project = await this.project(p.projectNumber), projectId = project.id;
    if (op === "detail") return { ...project, fields: await this.fields(projectId) };
    if (op === "items") {
      const data = await this.query(`query($id:ID!,$cursor:String){node(id:$id){...on ProjectV2{items(first:50,after:$cursor){nodes{${itemInfo}} pageInfo{hasNextPage endCursor}}}}}`, { id: projectId, cursor: p.cursor == null ? null : text(p.cursor, "cursor", 1000) });
      return { rows: data.node.items.nodes, nextCursor: data.node.items.pageInfo.hasNextPage ? data.node.items.pageInfo.endCursor : null };
    }
    if (op === "edit") {
      const input: Params = { projectId };
      for (const key of ["title", "shortDescription", "readme"] as const) if (p[key] !== undefined) input[key] = text(p[key], key, key === "readme" ? 65536 : 256, key !== "title");
      for (const key of ["closed", "public"] as const) if (p[key] !== undefined) { if (typeof p[key] !== "boolean") throw new Error(`Invalid ${key} setting.`); input[key] = p[key]; }
      if (p.public === true && !project.public) confirm(p, project.title);
      return this.mutate("updateProjectV2", "UpdateProjectV2Input", input, `projectV2{${info}}`);
    }
    if (op === "delete") { confirm(p, project.title); return this.mutate("deleteProjectV2", "DeleteProjectV2Input", { projectId }); }
    if (op === "add-item") {
      const repo = await this.repoNode(p.repositoryId, p.number);
      return this.mutate("addProjectV2ItemById", "AddProjectV2ItemByIdInput", { projectId, contentId: repo.contentId }, `item{${itemInfo}}`);
    }
    if (op === "link-repository" || op === "unlink-repository") {
      const repo = await this.repoNode(p.repositoryId);
      return this.mutate(op === "link-repository" ? "linkProjectV2ToRepository" : "unlinkProjectV2FromRepository", op === "link-repository" ? "LinkProjectV2ToRepositoryInput" : "UnlinkProjectV2FromRepositoryInput", { projectId, repositoryId: repo.id });
    }
    if (op === "add-draft") return this.mutate("addProjectV2DraftIssue", "AddProjectV2DraftIssueInput", { projectId, title: text(p.title, "title", 256), body: text(p.body ?? "", "description", 65536, true) }, "projectItem{id}");
    if (["create-field", "edit-field", "delete-field"].includes(op)) {
      const field = op === "create-field" ? null : (await this.fields(projectId)).find(f => f.id === p.fieldId);
      if (op !== "create-field" && !field) throw new Error("This field does not belong to this project.");
      if (op === "delete-field") { confirm(p, field.name); return this.mutate("deleteProjectV2Field", "DeleteProjectV2FieldInput", { fieldId: field.id }); }
      const type = op === "create-field" ? choice(p.dataType, ["TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"]) : field.dataType;
      const input: Params = { ...(field ? { fieldId: field.id } : { projectId, dataType: type }), name: text(p.name, "field name", 256) };
      if (type === "SINGLE_SELECT" && p.options !== undefined) {
        const names = strings(p.options, "options"); if (!names.length) throw new Error("Add at least one option.");
        if (field) confirm(p, field.name); // Replacing options can clear existing values.
        input.singleSelectOptions = names.map(name => { const previous = field?.options?.find((o: any) => o.name === name); return { name, color: previous?.color ?? "GRAY", description: previous?.description ?? "" }; });
      }
      if (type === "ITERATION") {
        const duration = integer(p.duration, "iteration duration in days"), start = text(p.startDate, "iteration start date", 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start)) || duration > 365) throw new Error("Choose a valid iteration start and duration.");
        const count = integer(p.iterationCount ?? 4, "iteration count"); if (count > 52) throw new Error("Use at most 52 iterations.");
        input.iterationConfiguration = { duration, startDate: start, iterations: Array.from({ length: count }, (_, i) => ({ title: `Iteration ${i + 1}`, duration, startDate: new Date(Date.parse(start) + i * duration * 86400000).toISOString().slice(0, 10) })) };
        if (field) confirm(p, field.name);
      }
      return this.mutate(op === "create-field" ? "createProjectV2Field" : "updateProjectV2Field", op === "create-field" ? "CreateProjectV2FieldInput" : "UpdateProjectV2FieldInput", input);
    }
    const item = await this.item(p.itemId, projectId);
    switch (op) {
      case "edit-draft":
        if (item.content?.__typename !== "DraftIssue") throw new Error("This item is not a draft.");
        return this.mutate("updateProjectV2DraftIssue", "UpdateProjectV2DraftIssueInput", { draftIssueId: item.content.id, title: text(p.title, "title", 256), body: text(p.body ?? "", "description", 65536, true) });
      case "convert-draft": {
        if (item.content?.__typename !== "DraftIssue") throw new Error("This item is not a draft.");
        const repo = await this.repoNode(p.repositoryId);
        return this.mutate("convertProjectV2DraftIssueItemToIssue", "ConvertProjectV2DraftIssueItemToIssueInput", { itemId: item.id, repositoryId: repo.id }, `item{${itemInfo}}`);
      }
      case "remove-item": confirm(p, item.content?.title ?? item.id); return this.mutate("deleteProjectV2Item", "DeleteProjectV2ItemInput", { projectId, itemId: item.id });
      case "archive-item": case "restore-item": return this.mutate(op === "archive-item" ? "archiveProjectV2Item" : "unarchiveProjectV2Item", op === "archive-item" ? "ArchiveProjectV2ItemInput" : "UnarchiveProjectV2ItemInput", { projectId, itemId: item.id });
      case "move-item": {
        if (p.afterId != null) await this.item(p.afterId, projectId);
        return this.mutate("updateProjectV2ItemPosition", "UpdateProjectV2ItemPositionInput", { projectId, itemId: item.id, afterId: p.afterId ?? null });
      }
      case "clear-field": case "set-field": {
        const field = (await this.fields(projectId)).find(f => f.id === p.fieldId);
        if (!field) throw new Error("This field does not belong to this project.");
        const input = { projectId, itemId: item.id, fieldId: field.id };
        if (op === "clear-field") return this.mutate("clearProjectV2ItemFieldValue", "ClearProjectV2ItemFieldValueInput", input);
        let value: Params;
        switch (field.dataType) {
          case "TEXT": value = { text: text(p.value, "text", 65536, true) }; break;
          case "NUMBER": if (typeof p.value !== "number" || !Number.isFinite(p.value)) throw new Error("Enter a valid number."); value = { number: p.value }; break;
          case "DATE": if (typeof p.value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.value) || !Number.isFinite(Date.parse(p.value))) throw new Error("Enter a valid date."); value = { date: p.value }; break;
          case "SINGLE_SELECT": if (!field.options.some((o: any) => o.id === p.value)) throw new Error("Choose one of this field’s options."); value = { singleSelectOptionId: p.value }; break;
          case "ITERATION": if (![...field.configuration.iterations, ...field.configuration.completedIterations].some((i: any) => i.id === p.value)) throw new Error("Choose one of this field’s iterations."); value = { iterationId: p.value }; break;
          default: throw new Error("Edit this built-in field on the issue or pull request.");
        }
        return this.mutate("updateProjectV2ItemFieldValue", "UpdateProjectV2ItemFieldValueInput", { ...input, value });
      }
      default: throw new Error("Unknown project action.");
    }
  }
}
