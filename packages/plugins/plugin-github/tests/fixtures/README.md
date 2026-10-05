# GitHub GraphQL contract fixture

`github-schema.graphql` is the public GitHub schema fetched from
https://raw.githubusercontent.com/octokit/graphql-schema/master/schema.graphql
on 2026-10-04. SHA-256: `3c62d0526d133cee53221c89de9b455ade24db78b9e7ad56d642c4c15bce2654`.

Management tests validate executed queries, mutations and input variables against
this snapshot without accessing the network. The upstream file contains two
repeated fields on the unrelated `EnterpriseOwnerInfo` type; the test loader
removes duplicate fields on that type only before building the schema. No queried
field or input is removed or relaxed. To refresh, fetch the official snapshot,
update this digest, and rerun the full plugin test suite.

Fixtures do not prove live GitHub permissions, branch protections or write acceptance.
