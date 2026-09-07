# Changelog

## [0.7.14](https://github.com/quynhonsemiconductor/rova/compare/v0.7.13...v0.7.14) (2026-09-07)


### 🐛 Bug Fixes

* **ci:** make the tag deploy wait for the develop deploy of the same commit ([#536](https://github.com/quynhonsemiconductor/rova/issues/536)) ([194de1d](https://github.com/quynhonsemiconductor/rova/commit/194de1d1a5f4db92d5c613420a620fdf0c7a1c50))
* **email:** centralize from-address resolution; add coverage-floor drift check ([#544](https://github.com/quynhonsemiconductor/rova/issues/544)) ([bd56840](https://github.com/quynhonsemiconductor/rova/commit/bd568406dc810173b548b28927e839a3e559a641))
* **observability:** align dashboard queries, alert tags and SES grant with product name ([845ae4a](https://github.com/quynhonsemiconductor/rova/commit/845ae4a843d7e0d3c3f3ae09ca77beda195447ff))


### ♻️ Refactors

* **db:** rename least-privilege roles to the new product name ([e942af6](https://github.com/quynhonsemiconductor/rova/commit/e942af6ece77dd06b902455acd5675eda02e2220))
* **infra:** move SES domain identity to platform tier, align qnsc-ci pins ([#543](https://github.com/quynhonsemiconductor/rova/issues/543)) ([6c7e5f7](https://github.com/quynhonsemiconductor/rova/commit/6c7e5f7fa6f8e91ecd7580c204272ded8d871de6))

## [0.7.13](https://github.com/QNSC-VN/rally/compare/v0.7.12...v0.7.13) (2026-08-31)


### ✨ Features

* **infra:** wire cache CPU/memory/eviction alarms, same as opshub ([#532](https://github.com/QNSC-VN/rally/issues/532)) ([7045d60](https://github.com/QNSC-VN/rally/commit/7045d60f052d49e16d6cca9467cfaaac9ca05e9d))


### 🐛 Bug Fixes

* volume-gate the low-traffic latency alerts, warm the DB pool, bound the interactive storage budget ([#535](https://github.com/QNSC-VN/rally/issues/535)) ([a00283a](https://github.com/QNSC-VN/rally/commit/a00283af215b34a234d35e705bbf0e5a512d6758))

## [0.7.12](https://github.com/QNSC-VN/rally/compare/v0.7.11...v0.7.12) (2026-08-30)


### 🐛 Bug Fixes

* **infra:** login failure-rate panel showing "No data" at zero failures ([#529](https://github.com/QNSC-VN/rally/issues/529)) ([836ba4d](https://github.com/QNSC-VN/rally/commit/836ba4d55d23bb3731c7c9233766396118e1daab))
* **infra:** zero-error absent-vector bug on 3 ratio panels/alerts, move Login panel up ([#531](https://github.com/QNSC-VN/rally/issues/531)) ([daa522a](https://github.com/QNSC-VN/rally/commit/daa522ad912226d87a7025c050a0454a5c3ec67e))

## [0.7.11](https://github.com/QNSC-VN/rally/compare/v0.7.10...v0.7.11) (2026-08-30)


### ✨ Features

* **identity:** record auth.login metric on the BFF login paths ([#526](https://github.com/QNSC-VN/rally/issues/526)) ([4f09097](https://github.com/QNSC-VN/rally/commit/4f0909736120adfbc5ef3cd6ed02f9cfcd8676ee))
* **infra:** dashboard panel + alert for the new auth.login metric ([#528](https://github.com/QNSC-VN/rally/issues/528)) ([1152f82](https://github.com/QNSC-VN/rally/commit/1152f829f2664bc42aff2ba361b4e67ab5aec572))

## [0.7.10](https://github.com/QNSC-VN/rally/compare/v0.7.9...v0.7.10) (2026-08-30)


### ✨ Features

* **infra:** file rally's SLO under the shared QNSC SLOs folder ([#525](https://github.com/QNSC-VN/rally/issues/525)) ([073ded7](https://github.com/QNSC-VN/rally/commit/073ded7fb2a59b1393881ec36f2a6dbd6ad51727))


### 🐛 Bug Fixes

* **infra:** create rally's dashboard folder centrally, stop duplicating it ([#522](https://github.com/QNSC-VN/rally/issues/522)) ([f85f8ad](https://github.com/QNSC-VN/rally/commit/f85f8adc1b7bd247ca583cece595655a7380ad17))
* **infra:** update stale Grafana folder UIDs after qnsc-infra re-parenting ([#524](https://github.com/QNSC-VN/rally/issues/524)) ([81e8750](https://github.com/QNSC-VN/rally/commit/81e8750b344decd74273f1f0bff73c63e48047cc))

## [0.7.9](https://github.com/QNSC-VN/rally/compare/v0.7.8...v0.7.9) (2026-08-30)


### 🐛 Bug Fixes

* **infra:** bump observability-alerts to v1.1.1, fixes prod apply failure ([#520](https://github.com/QNSC-VN/rally/issues/520)) ([3452970](https://github.com/QNSC-VN/rally/commit/3452970739ef28d20dfbfdcad3217ca1ba6fb455))

## [0.7.8](https://github.com/QNSC-VN/rally/compare/v0.7.7...v0.7.8) (2026-08-29)


### ✨ Features

* **infra:** CloudWatch alarms for the SES bounce/complaint queue ([#515](https://github.com/QNSC-VN/rally/issues/515)) ([b5fb543](https://github.com/QNSC-VN/rally/commit/b5fb543be4448ec6a74d8f3ec4879b74c89ef3c9))
* **infra:** drop CloudWatch dual-write, Grafana-only for logs ([#507](https://github.com/QNSC-VN/rally/issues/507)) ([9bbd20b](https://github.com/QNSC-VN/rally/commit/9bbd20bd65ec781d597b200edc4809898f5f411d))
* **infra:** HTTP availability SLO with burn-rate alerting ([#517](https://github.com/QNSC-VN/rally/issues/517)) ([47c0d55](https://github.com/QNSC-VN/rally/commit/47c0d5571c2d0300922d78d96f58bdc72e228dd2))
* **infra:** Logs Explorer panel + trace-search Explore link ([#514](https://github.com/QNSC-VN/rally/issues/514)) ([8de1f3e](https://github.com/QNSC-VN/rally/commit/8de1f3e35433705681ea84d6b447855c0c55ca86))
* **infra:** production alert thresholds stricter than develop ([#512](https://github.com/QNSC-VN/rally/issues/512)) ([034aeac](https://github.com/QNSC-VN/rally/commit/034aeacb57af2f44d10925e7bc0bfd7bd410de83))
* **infra:** provision rally's Grafana dashboard ([#510](https://github.com/QNSC-VN/rally/issues/510)) ([4fc8d35](https://github.com/QNSC-VN/rally/commit/4fc8d356bc1cf1850c7b11bcdf0eec7333a2fb7c))
* **infra:** recent-errors and log-volume panels on dashboards ([#511](https://github.com/QNSC-VN/rally/issues/511)) ([839ddec](https://github.com/QNSC-VN/rally/commit/839ddecf5470d6b8a4f8850904359d42e0d55bba))
* **infra:** runbook links on every Grafana alert rule ([#516](https://github.com/QNSC-VN/rally/issues/516)) ([4b4b891](https://github.com/QNSC-VN/rally/commit/4b4b891bc0562a1b7fb21a143672cd7724b56cba))
* **infra:** wire firelens-agent, dual-write logs to CloudWatch and Grafana ([#502](https://github.com/QNSC-VN/rally/issues/502)) ([0684dde](https://github.com/QNSC-VN/rally/commit/0684dde653c6ede160527bac920ba080dd027335))
* **infra:** wire Grafana Alerting for DB pool, HTTP errors, latency, worker failures ([#509](https://github.com/QNSC-VN/rally/issues/509)) ([dfd6b2e](https://github.com/QNSC-VN/rally/commit/dfd6b2e62eb3d44063cdfdd1069cb3b3e45bd63f))
* **infra:** wire otlp_endpoint to the live Grafana Cloud stack ([#500](https://github.com/QNSC-VN/rally/issues/500)) ([bcb7125](https://github.com/QNSC-VN/rally/commit/bcb71258127ed3ebc4b317367c48423d5692723c))


### 🐛 Bug Fixes

* **api:** remove double SIGTERM/SIGINT handler causing pool.end() twice ([#518](https://github.com/QNSC-VN/rally/issues/518)) ([5ae156b](https://github.com/QNSC-VN/rally/commit/5ae156be4fcbfb7c1f503322c9a367036e0d3673))
* **infra:** bump ecs-service to v2.3.1, grants s3:GetBucketLocation ([#504](https://github.com/QNSC-VN/rally/issues/504)) ([b417a03](https://github.com/QNSC-VN/rally/commit/b417a03c2c7270a7a9f078f6b0364e44977b1031))
* **infra:** bump firelens-agent to v0.1.1, task-role S3 grant not execution-role ([#503](https://github.com/QNSC-VN/rally/issues/503)) ([31922eb](https://github.com/QNSC-VN/rally/commit/31922eb0d0d5670b63c948f60b4d8e1bd97c6eb5))
* **infra:** bump firelens-agent to v0.1.2, real Fluent Bit init version ([#505](https://github.com/QNSC-VN/rally/issues/505)) ([65e7cb7](https://github.com/QNSC-VN/rally/commit/65e7cb7ad574dd637306789115ea3d8b0de1c435))
* **infra:** bump firelens-agent to v0.1.3, fixes \$message escaping crash ([#506](https://github.com/QNSC-VN/rally/issues/506)) ([412a354](https://github.com/QNSC-VN/rally/commit/412a35432f59e2320c126794fb02f4ae5937779e))
* **infra:** bump firelens-agent, wire service_name/product/env for correct log labels ([#508](https://github.com/QNSC-VN/rally/issues/508)) ([0380eff](https://github.com/QNSC-VN/rally/commit/0380eff98f5e4466c61f4b349a805d5377168607))
* **infra:** dashboard panel bugs found on a real screenshot review ([#513](https://github.com/QNSC-VN/rally/issues/513)) ([c6782e5](https://github.com/QNSC-VN/rally/commit/c6782e5dbf76a9d98ab636865c87ab25fd8312de))

## [0.7.7](https://github.com/QNSC-VN/rally/compare/v0.7.6...v0.7.7) (2026-08-25)


### ✨ Features

* **ci:** add zizmor Actions-security scan job ([#493](https://github.com/QNSC-VN/rally/issues/493)) ([74d111f](https://github.com/QNSC-VN/rally/commit/74d111f65ae949495ab701ddc357ed567e99851e))


### 🐛 Bug Fixes

* **ci:** add missing packages:read to backend-deploy caller permissions ([#497](https://github.com/QNSC-VN/rally/issues/497)) ([92ef015](https://github.com/QNSC-VN/rally/commit/92ef015920905c68e354977099d8b21d1b19b6b1))
* **ci:** code injection, scope permissions, persist-credentials, enforce zizmor ([#495](https://github.com/QNSC-VN/rally/issues/495)) ([a2d5292](https://github.com/QNSC-VN/rally/commit/a2d5292e877851ec8f92d86aa10952ff321ceee5))
* **ci:** restore deploy permissions broken by the zizmor excessive-permissions fix ([#496](https://github.com/QNSC-VN/rally/issues/496)) ([c4cf28d](https://github.com/QNSC-VN/rally/commit/c4cf28d3877ff8643c8720d8a01a2e9ce1c6f283))
* **web:** seven layout defects, and the shared components behind them ([#492](https://github.com/QNSC-VN/rally/issues/492)) ([b314bf9](https://github.com/QNSC-VN/rally/commit/b314bf978ff676913fb35a9f8925e5bb065caab5))

## [0.7.6](https://github.com/QNSC-VN/rally/compare/v0.7.5...v0.7.6) (2026-08-23)


### ✨ Features

* **infra:** per-environment email feedback chains — verdicts land in the database that sent them ([#480](https://github.com/QNSC-VN/rally/issues/480)) ([72c8464](https://github.com/QNSC-VN/rally/commit/72c8464b14ca664ff8a682d2c9abac0c016bd97e))
* **work-items,iterations:** align the remaining BA scope from c42df59 ([#485](https://github.com/QNSC-VN/rally/issues/485)) ([ac593fe](https://github.com/QNSC-VN/rally/commit/ac593fec04222133cd1fccbcd3aecff34226b923))


### 🐛 Bug Fixes

* **iteration-status,backlog,portfolio:** scope every Owner feed to the row's Team, give a row its Delete, and point the chevrons at time ([#486](https://github.com/QNSC-VN/rally/issues/486)) ([e046f9f](https://github.com/QNSC-VN/rally/commit/e046f9fbd49a6ea785731eca48a31434f98fd67a))
* **web:** eight UI/UX reports, and the shared components they came from ([#487](https://github.com/QNSC-VN/rally/issues/487)) ([815e205](https://github.com/QNSC-VN/rally/commit/815e205159d345386b2c660fc5b590842ad64af7))
* **work-items:** derive the parent Schedule State from its task set, as Rally does ([#482](https://github.com/QNSC-VN/rally/issues/482)) ([b4a75d2](https://github.com/QNSC-VN/rally/commit/b4a75d227e7c7b83ca8dbd39e2900eaba33d06d3))
* **work-items:** feed the Parent Story picker from the write's rule, not the Backlog's ([#484](https://github.com/QNSC-VN/rally/issues/484)) ([929590e](https://github.com/QNSC-VN/rally/commit/929590ece683e3c834e96de44519d42b96dbd1ea))
* **workspace,projects:** staff a Team from its Project, and show the Workspace Admin on it ([#483](https://github.com/QNSC-VN/rally/issues/483)) ([50954ad](https://github.com/QNSC-VN/rally/commit/50954ad2b7d237ebf5f712e4851229681efb9678))

## [0.7.5](https://github.com/QNSC-VN/rally/compare/v0.7.4...v0.7.5) (2026-08-21)


### 🐛 Bug Fixes

* **worker:** keep the SMTP diagnostic when a bounce matches no row ([#478](https://github.com/QNSC-VN/rally/issues/478)) ([fd465d7](https://github.com/QNSC-VN/rally/commit/fd465d701ed8816c514c188db7bd37fc061e0778))

## [0.7.4](https://github.com/QNSC-VN/rally/compare/v0.7.3...v0.7.4) (2026-08-21)


### 🐛 Bug Fixes

* **infra:** allow the SES configuration-set ARN the tagged sends touch ([#476](https://github.com/QNSC-VN/rally/issues/476)) ([93e8649](https://github.com/QNSC-VN/rally/commit/93e8649f0779cefeec6ef3c43d76c92438a5b7bf))
* **infra:** the SQS queue policy the SNS-to-SQS delivery always needed ([#475](https://github.com/QNSC-VN/rally/issues/475)) ([775cff0](https://github.com/QNSC-VN/rally/commit/775cff01a9f873756901ae42b6ee7d3a8c352bb7))

## [0.7.3](https://github.com/QNSC-VN/rally/compare/v0.7.2...v0.7.3) (2026-08-21)


### 🐛 Bug Fixes

* **worker:** import ApiTokensModule — the worker crash-loops at boot without it ([#473](https://github.com/QNSC-VN/rally/issues/473)) ([30659c8](https://github.com/QNSC-VN/rally/commit/30659c8ebec8c1b7509a67d9fba2f6366876ca5f))

## [0.7.2](https://github.com/QNSC-VN/rally/compare/v0.7.1...v0.7.2) (2026-08-20)


### ✨ Features

* **auth:** mint API tokens for machine clients ([#456](https://github.com/QNSC-VN/rally/issues/456)) ([5e2bc0d](https://github.com/QNSC-VN/rally/commit/5e2bc0d83fbf2b6c57855de1f485f271320fef29))
* **email:** surface SES bounce and complaint verdicts on the rows that sent them ([#468](https://github.com/QNSC-VN/rally/issues/468)) ([c74ffec](https://github.com/QNSC-VN/rally/commit/c74ffecfc340b63354bd2b51a6a7cb78a955c8a0))
* **infra:** move rally develop's shutdown from 19:00 back to midnight ([#459](https://github.com/QNSC-VN/rally/issues/459)) ([ae3c31a](https://github.com/QNSC-VN/rally/commit/ae3c31a123ca48cb2827b8136132a2b098995da4))
* **settings:** give the archive a place, and a guarded delete ([#465](https://github.com/QNSC-VN/rally/issues/465)) ([45c29a6](https://github.com/QNSC-VN/rally/commit/45c29a6b5cf98570b7f70980b133607d51e28dfb))
* **teams:** let a Workspace Admin be a Team member, badged not levelled ([#463](https://github.com/QNSC-VN/rally/issues/463)) ([11821b1](https://github.com/QNSC-VN/rally/commit/11821b199437df0a8518b30097292f198edb33e4))
* **web:** manage API tokens in Settings ([#460](https://github.com/QNSC-VN/rally/issues/460)) ([7514cf8](https://github.com/QNSC-VN/rally/commit/7514cf8337ddbe7fcf42da704e8c486e19f92483))
* **workspace:** internal-domain members + copy-invitation-link ([#466](https://github.com/QNSC-VN/rally/issues/466)) ([630977f](https://github.com/QNSC-VN/rally/commit/630977f819f6d953f23a82e9ed88f33a60e34318))


### 🐛 Bug Fixes

* **delivery:** make a defect deletable, and stop a refusal reading as a broken button ([#469](https://github.com/QNSC-VN/rally/issues/469)) ([f8ea70c](https://github.com/QNSC-VN/rally/commit/f8ea70cd72a06650b6a8ae5b391918a219ccc9e9))
* **web:** a 405 that never worked, a picker that could not offer, and two more ([#467](https://github.com/QNSC-VN/rally/issues/467)) ([d62a1aa](https://github.com/QNSC-VN/rally/commit/d62a1aa1581f1c91028517a59b9c5ec8451d23f8))
* **web:** raise the UI type scale, honour font-size preference, hold a 24px target floor ([#471](https://github.com/QNSC-VN/rally/issues/471)) ([e2ab702](https://github.com/QNSC-VN/rally/commit/e2ab7025661c2ad98964dc41eb693ca4f822c19d))
* **web:** return the reader where they came from when leaving a detail ([#472](https://github.com/QNSC-VN/rally/issues/472)) ([fc0bc1a](https://github.com/QNSC-VN/rally/commit/fc0bc1a0562c84a879cc5811577510ec540160a3))


### ♻️ Refactors

* **settings:** one builder per person and team dropdown, and two leaky glyphs ([#470](https://github.com/QNSC-VN/rally/issues/470)) ([df459ee](https://github.com/QNSC-VN/rally/commit/df459eebc6f42c14714ce4a1745415ec31bc29c9))

## [0.7.1](https://github.com/QNSC-VN/rally/compare/v0.7.0...v0.7.1) (2026-08-18)


### 🐛 Bug Fixes

* **infra:** let Terraform write the tunnel's ingress rule, production first ([#452](https://github.com/QNSC-VN/rally/issues/452)) ([abf7477](https://github.com/QNSC-VN/rally/commit/abf7477cb8964195a022ac8d338980f367d6723f))

## [0.7.0](https://github.com/QNSC-VN/rally/compare/v0.6.1...v0.7.0) (2026-08-18)


### ⚠ BREAKING CHANGES

* **web,infra:** make every non-admin role behave as the BA specified, and make email possible ([#430](https://github.com/QNSC-VN/rally/issues/430))
* **reports,releases,notifications,settings:** seven fields are removed from the release response DTO. No consumer remained: the panel that read them is deleted, and the SPA reads the roll-up instead.

### ✨ Features

* **backlog:** rank-to-edge actions; fix: name our burnup line a target baseline ([#385](https://github.com/QNSC-VN/rally/issues/385)) ([3ba3add](https://github.com/QNSC-VN/rally/commit/3ba3add85eade8d6078d33b3c5fe3ce4dd2dec3a))
* **capacity:** a reader sees only its own team inside a published plan (AC-010) ([#324](https://github.com/QNSC-VN/rally/issues/324)) ([a519e32](https://github.com/QNSC-VN/rally/commit/a519e3232501da7820e3ddba4be7c54eea7000af))
* **capacity:** add Rally's plan Actions menu, and let a published plan be deleted ([#302](https://github.com/QNSC-VN/rally/issues/302)) ([3ddc486](https://github.com/QNSC-VN/rally/commit/3ddc48656cd978063646e8a2e99b364f60a1b0e1))
* **capacity:** an allocation's value is a fixed snapshot with a source ([#366](https://github.com/QNSC-VN/rally/issues/366)) ([c08b76f](https://github.com/QNSC-VN/rally/commit/c08b76f80dbcc82fce9d21f5fe5a54f52948c2f9))
* **capacity:** apply the BA rulings on team column, move targets and forecast ([#327](https://github.com/QNSC-VN/rally/issues/327)) ([45964ab](https://github.com/QNSC-VN/rally/commit/45964abeb42443e5be8aad6f6753b8609262af35))
* **capacity:** editable Planned Team Assignment and rank drag ([#305](https://github.com/QNSC-VN/rally/issues/305)) ([cc4bc37](https://github.com/QNSC-VN/rally/commit/cc4bc375c56ab800af8aa78bca0126b530cbc27c))
* **capacity:** hide Draft plans from readers (AC-013) ([#323](https://github.com/QNSC-VN/rally/issues/323)) ([7349eb1](https://github.com/QNSC-VN/rally/commit/7349eb1c939b633ef33ed3d28ad2b5f6eb14652a))
* **capacity:** match Rally's allocate dialog, Actions menu and gear ([#306](https://github.com/QNSC-VN/rally/issues/306)) ([e0e688c](https://github.com/QNSC-VN/rally/commit/e0e688c7304e62dd2d1c31b2301dcff5628f2283))
* **capacity:** match Rally's plan detail — full width, sub-tables, Project column ([#300](https://github.com/QNSC-VN/rally/issues/300)) ([0630956](https://github.com/QNSC-VN/rally/commit/0630956baa2a31f3ac5bf8fd3b6a0d1a08563c4e))
* **capacity:** move a Feature to another plan ([#308](https://github.com/QNSC-VN/rally/issues/308)) ([bcc0000](https://github.com/QNSC-VN/rally/commit/bcc00003c6f9f69971be064bc2409f7db2e8a2a8))
* **capacity:** Rally's column order, sorting and rail on both plan tabs ([#311](https://github.com/QNSC-VN/rally/issues/311)) ([a2167da](https://github.com/QNSC-VN/rally/commit/a2167da58d6e9956f66d9f03717dca59cb87a0b5))
* **capacity:** remove a Feature from a plan in one call ([#322](https://github.com/QNSC-VN/rally/issues/322)) ([70fade6](https://github.com/QNSC-VN/rally/commit/70fade6379a46a1f65a8792acba1245e895942c4))
* **capacity:** removing a team re-parks its demand instead of refusing ([#321](https://github.com/QNSC-VN/rally/issues/321)) ([d2153d0](https://github.com/QNSC-VN/rally/commit/d2153d009e90aa0117f8bb728134c9480db7bec3))
* **capacity:** the BA's Feature-level warnings on the Features tab ([#319](https://github.com/QNSC-VN/rally/issues/319)) ([e212cdb](https://github.com/QNSC-VN/rally/commit/e212cdbc28c7b5f3700601669a833a4b4b1f47ae))
* **capacity:** trim the plan list, and give its header the app's own lead ([#304](https://github.com/QNSC-VN/rally/issues/304)) ([72a4d21](https://github.com/QNSC-VN/rally/commit/72a4d21de6da9a49a9ae5b1cbadfccbb019772b2))
* **identity:** make the invitation flow work end to end, and provision invited externals as Entra guests ([#435](https://github.com/QNSC-VN/rally/issues/435)) ([0f40841](https://github.com/QNSC-VN/rally/commit/0f4084134d14f3341d0c8aede73d8a36c37a723f))
* **infra:** adopt the shared cf-tunnel module (step 1: adopt only) ([#411](https://github.com/QNSC-VN/rally/issues/411)) ([84794b4](https://github.com/QNSC-VN/rally/commit/84794b42c14fef4edb61dae31e73f80135141cfb))
* **infra:** align SPF for SES via a custom MAIL FROM subdomain ([#432](https://github.com/QNSC-VN/rally/issues/432)) ([b50d074](https://github.com/QNSC-VN/rally/commit/b50d074b084b719cb6bf0a9ecc8364c95c0ba665))
* **infra:** bring rally production out of pre-launch idle ([#445](https://github.com/QNSC-VN/rally/issues/445)) ([0f0bf98](https://github.com/QNSC-VN/rally/commit/0f0bf989cb9d52802d778a8d25bdcdf47c3173ed))
* **infra:** enable Entra B2B guest provisioning on develop ([#438](https://github.com/QNSC-VN/rally/issues/438)) ([731c4b3](https://github.com/QNSC-VN/rally/commit/731c4b32f5fbb14e95364824f97db61e36041bfc))
* **infra:** move rally develop onto the shared Valkey node ([#448](https://github.com/QNSC-VN/rally/issues/448)) ([8aea6c1](https://github.com/QNSC-VN/rally/commit/8aea6c17ab71eb1eb55dc8a226aaf211655847aa))
* **infra:** run develop on working hours only ([#446](https://github.com/QNSC-VN/rally/issues/446)) ([86b8fe7](https://github.com/QNSC-VN/rally/commit/86b8fe7ce44b34500a9a7f0d29ce0e3f90b2c424))
* **infra:** serve rally through Cloudflare Tunnel instead of ALBs ([#326](https://github.com/QNSC-VN/rally/issues/326)) ([9395849](https://github.com/QNSC-VN/rally/commit/939584921042ae13070a13240c82b456bc490615))
* **infra:** wake develop on a weekday morning schedule ([#390](https://github.com/QNSC-VN/rally/issues/390)) ([082171f](https://github.com/QNSC-VN/rally/commit/082171f14ff0dc06cfd828e83fbb233da7859221))
* **iterations:** add Task Estimate column (IT-001) ([#400](https://github.com/QNSC-VN/rally/issues/400)) ([7c4a00f](https://github.com/QNSC-VN/rally/commit/7c4a00fe5a74789d6fa5a8a59d389e1e5ff5efc2))
* **observability:** local OTLP collector, and make OTEL_ENABLED actually work ([#406](https://github.com/QNSC-VN/rally/issues/406)) ([6b4cba6](https://github.com/QNSC-VN/rally/commit/6b4cba69bd82e59e5e9b44d3cee54d4458da0644))
* per-project estimation settings + Settings &gt; Workspaces & Projects overhaul ([#424](https://github.com/QNSC-VN/rally/issues/424)) ([d6db014](https://github.com/QNSC-VN/rally/commit/d6db014c956821853fcc3b45f96fe40b9f92afb1))
* **portfolio:** create the level you are looking at, with the SRS's full field list ([#367](https://github.com/QNSC-VN/rally/issues/367)) ([313bccc](https://github.com/QNSC-VN/rally/commit/313bccce7e84437af69775f6859e86d0799463bd))
* **portfolio:** detail page parity — polymorphic comments and attachments, Total Accepted Children ([#307](https://github.com/QNSC-VN/rally/issues/307)) ([dc5be0a](https://github.com/QNSC-VN/rally/commit/dc5be0aaec2db933ac162c2cce96c4c185242afb))
* **portfolio:** give the Children tab the Iteration Status chrome, and a drag grip ([#353](https://github.com/QNSC-VN/rally/issues/353)) ([1b8aa15](https://github.com/QNSC-VN/rally/commit/1b8aa15b1ee76e598a876df5bec11dbb0e2b2150))
* **portfolio:** inline-edit and expand-to-Tasks on the Children tab ([#347](https://github.com/QNSC-VN/rally/issues/347)) ([1e36342](https://github.com/QNSC-VN/rally/commit/1e3634286f519325df083da8d538dfa07e0cc0e3))
* **portfolio:** Milestone, Archive, and an editable Preliminary Estimate scale ([#310](https://github.com/QNSC-VN/rally/issues/310)) ([e616e75](https://github.com/QNSC-VN/rally/commit/e616e75dc14c32227690688f0c06fb9f6cfd2844))
* **portfolio:** rank by up/down buttons, and finish the grid the SRS asks for ([#369](https://github.com/QNSC-VN/rally/issues/369)) ([8dfc107](https://github.com/QNSC-VN/rally/commit/8dfc1072396733a67b825e51aff2a78d0f179104))
* **portfolio:** real Children tables on Feature and Epic detail ([#325](https://github.com/QNSC-VN/rally/issues/325)) ([c500187](https://github.com/QNSC-VN/rally/commit/c500187ca3e0dae1044768c859a563d7561c91aa))
* **portfolio:** shared attribute cells + Epic/Feature row disclosure ([#303](https://github.com/QNSC-VN/rally/issues/303)) ([aa0e814](https://github.com/QNSC-VN/rally/commit/aa0e814c6760d32e50f0a477b7ab5c1a42888720))
* **portfolio:** the BA behaviours that were missing outright ([#337](https://github.com/QNSC-VN/rally/issues/337)) ([7193e7c](https://github.com/QNSC-VN/rally/commit/7193e7c6f7fe243d43c40aa8ee48a4e89617ee12))
* **portfolio:** What Success Looks Like, a create menu, and no metrics strip ([#328](https://github.com/QNSC-VN/rally/issues/328)) ([fc05c71](https://github.com/QNSC-VN/rally/commit/fc05c710aa1dd7d00d91b6f4a1ecdbfbd9d73dba))
* **rbac:** per-Project access levels — backend spine (Phases 1-3) ([#412](https://github.com/QNSC-VN/rally/issues/412)) ([a008382](https://github.com/QNSC-VN/rally/commit/a008382c3f76b8e71031eb3b234bab7d416c2d30))
* **reports:** the Phase 6 reports and Portfolio &gt; Release Tracking ([#329](https://github.com/QNSC-VN/rally/issues/329)) ([43ab33d](https://github.com/QNSC-VN/rally/commit/43ab33d514ec8262175cdc3a818774f2a4aa2af4))


### 🐛 Bug Fixes

* **access,delivery,audit:** close the access model, the read boundary, and six more P1 findings ([#429](https://github.com/QNSC-VN/rally/issues/429)) ([6c65b32](https://github.com/QNSC-VN/rally/commit/6c65b327929c60d46a3623cdedacf0de7951a6b6))
* **access:** a task's own id resolves, so tasks can be edited again ([#348](https://github.com/QNSC-VN/rally/issues/348)) ([bfaee2b](https://github.com/QNSC-VN/rally/commit/bfaee2bac7edd445d3ac57d2a9d6a6c7b0453da4))
* **audit,work-items,capacity,projects,settings:** close fifteen P1 audit findings ([#428](https://github.com/QNSC-VN/rally/issues/428)) ([61bed41](https://github.com/QNSC-VN/rally/commit/61bed417be41d7af478c553c399ec6be73f51e9a))
* **audit:** project outbox events to audit_logs directly instead of via SNS ([#394](https://github.com/QNSC-VN/rally/issues/394)) ([7a432ae](https://github.com/QNSC-VN/rally/commit/7a432aedd10a59009a97f98b686663c8f4fdcece))
* **audit:** re-audit P1s + finish self-defeated fixes (IT-001 dead col, Team 400, cache, TS-008 dup, breadcrumb, cascade) ([#401](https://github.com/QNSC-VN/rally/issues/401)) ([058ec98](https://github.com/QNSC-VN/rally/commit/058ec98a7bbb7eed963242006da2516558976e46))
* **audit:** re-audit P2/P3 batch (role lockout, IS To Do, RT em-dash, TS aggregates+picker, publish count) ([#402](https://github.com/QNSC-VN/rally/issues/402)) ([cc4d508](https://github.com/QNSC-VN/rally/commit/cc4d508e0d3c9c10342c952149ddc2d48942f016))
* **audit:** recover lost C6/P2/C7 from [#396](https://github.com/QNSC-VN/rally/issues/396) + SET-001 + P6-COM-006 ([#398](https://github.com/QNSC-VN/rally/issues/398)) ([296ce5a](https://github.com/QNSC-VN/rally/commit/296ce5a9e2aa3fd8d833ae041b15ea2db491b39f))
* **audit:** resolve P0/P1 bugs from Phase 0-6 audit ([#396](https://github.com/QNSC-VN/rally/issues/396)) ([9e21854](https://github.com/QNSC-VN/rally/commit/9e2185437e8ed03e0b77fc70586592c82eb0e050))
* **capacity:** five open defects from the Phase 5 audit ([#317](https://github.com/QNSC-VN/rally/issues/317)) ([b60edad](https://github.com/QNSC-VN/rally/commit/b60edadbcb2538b066d045dabc3f5e44ca745b34))
* **capacity:** honor primary pick on a newly-added Allocate team row ([#403](https://github.com/QNSC-VN/rally/issues/403)) ([851a13f](https://github.com/QNSC-VN/rally/commit/851a13f419f7d73b0b10929e4b862178d4037527))
* **capacity:** layout regressions from the column reorder ([#312](https://github.com/QNSC-VN/rally/issues/312)) ([52c6aa3](https://github.com/QNSC-VN/rally/commit/52c6aa310ebc176ff1f22307954e23aa7da08aff))
* **capacity:** match the Estimate tooltip to Rally, row for row ([#376](https://github.com/QNSC-VN/rally/issues/376)) ([35be675](https://github.com/QNSC-VN/rally/commit/35be67590c70a2c34365351f062001ff4463abc2))
* **capacity:** referential integrity and the plan's own unit ([#315](https://github.com/QNSC-VN/rally/issues/315)) ([bfe10d7](https://github.com/QNSC-VN/rally/commit/bfe10d7af7352c5fb39f5ff5d4707005a992b158))
* **capacity:** refuse the references that used to orphan a plan, add view_draft ([#335](https://github.com/QNSC-VN/rally/issues/335)) ([3e7e65b](https://github.com/QNSC-VN/rally/commit/3e7e65b4b2e3b8aa64d68473a97a1db0aea955c6))
* **capacity:** stop the move destroying allocation values, and follow AC-019 ([#334](https://github.com/QNSC-VN/rally/issues/334)) ([be5dbdc](https://github.com/QNSC-VN/rally/commit/be5dbdc903b0dda549f74e85c6d0c244ab0c47df))
* **capacity:** the BA's cutline boundary, and a Team picker that ignores Release ([#372](https://github.com/QNSC-VN/rally/issues/372)) ([6a25467](https://github.com/QNSC-VN/rally/commit/6a25467deb7813e1c260d20b3f1a3b327d9c790d))
* **capacity:** warn only on real breaches, and warn about the plan itself ([#363](https://github.com/QNSC-VN/rally/issues/363)) ([751ba16](https://github.com/QNSC-VN/rally/commit/751ba161a60e7d679c61f2497c2485562a1fc1c7))
* **ci:** give the shared apply the Cloudflare token it needs ([#431](https://github.com/QNSC-VN/rally/issues/431)) ([40e18ec](https://github.com/QNSC-VN/rally/commit/40e18ecee638b7f6bc44434b4225f2572a45786a))
* **ci:** stop dependabot updating terraform providers ([#422](https://github.com/QNSC-VN/rally/issues/422)) ([faba6fc](https://github.com/QNSC-VN/rally/commit/faba6fce066377e0899261d04469a00906434fb7))
* close 14 BA retest findings, and report the 13 already fixed ([#434](https://github.com/QNSC-VN/rally/issues/434)) ([1dc027f](https://github.com/QNSC-VN/rally/commit/1dc027f3b2292f929980f33e3a8c2673250816da))
* close every case in the BA retest of 2026-08-17, and the Project Backlog ruling ([#450](https://github.com/QNSC-VN/rally/issues/450)) ([817a507](https://github.com/QNSC-VN/rally/commit/817a507ab94b5a5e0fb09859270a9b73c52a61e4))
* **db:** recover outbox events dead-lettered against the deleted SNS topic ([#395](https://github.com/QNSC-VN/rally/issues/395)) ([53bc9be](https://github.com/QNSC-VN/rally/commit/53bc9beecf7cf21e94aa481140b8ed452b6b70ab))
* destructive-action gate, Team optional, and Portfolio bulk-label consistency ([#384](https://github.com/QNSC-VN/rally/issues/384)) ([945092a](https://github.com/QNSC-VN/rally/commit/945092a14e6f8572dea724045235d5a5fe758ff0))
* **identity:** resolve bundled secret refs, unbreaking SSO login ([#358](https://github.com/QNSC-VN/rally/issues/358)) ([c8200e3](https://github.com/QNSC-VN/rally/commit/c8200e3d9b4b9f2fd36677f2f7c1d98026b8c648))
* **infra:** adopt the prod RDS log group via an import block ([#444](https://github.com/QNSC-VN/rally/issues/444)) ([d712ec2](https://github.com/QNSC-VN/rally/commit/d712ec24b158a1fb6930fc6f28364ac0aba5844c))
* **infra:** grant the api execution role the tunnel token secret ([#414](https://github.com/QNSC-VN/rally/issues/414)) ([3c51db4](https://github.com/QNSC-VN/rally/commit/3c51db4eb343d8cb7c17aa98f0584f4c0fd3b22c))
* **infra:** make the five guards actually fail, instead of warning ([#392](https://github.com/QNSC-VN/rally/issues/392)) ([c96fd12](https://github.com/QNSC-VN/rally/commit/c96fd129056efbf58b19f47692599fd548c409d8))
* **infra:** require idle_schedule to fire at least daily ([#416](https://github.com/QNSC-VN/rally/issues/416)) ([e09b23d](https://github.com/QNSC-VN/rally/commit/e09b23d5a15fda98ff7a19c71caf6368273bdd1c))
* **infra:** stop paying for an ingress check against zero tasks ([#393](https://github.com/QNSC-VN/rally/issues/393)) ([6948ac9](https://github.com/QNSC-VN/rally/commit/6948ac9a32bbfe8b65305c53776145147ca990df))
* **platform:** no deployed environment could send email ([#336](https://github.com/QNSC-VN/rally/issues/336)) ([3db1231](https://github.com/QNSC-VN/rally/commit/3db12314ac89d6668ed2d3fdce4f00543bf206c1))
* **platform:** tier auth rate limits by what crosses the boundary, not by route name ([#440](https://github.com/QNSC-VN/rally/issues/440)) ([2c287c2](https://github.com/QNSC-VN/rally/commit/2c287c2496d67494f387cf19dedbca0f542da15b))
* **portfolio:** archived items are read-only, and the estimate ships resolved ([#368](https://github.com/QNSC-VN/rally/issues/368)) ([f47f3a3](https://github.com/QNSC-VN/rally/commit/f47f3a328d69de55f01094c1e021d26f1067b362))
* **portfolio:** match the BA-specified detail layout and Rally's accepted-children panel ([#309](https://github.com/QNSC-VN/rally/issues/309)) ([f8c917f](https://github.com/QNSC-VN/rally/commit/f8c917f505b781bd40aa084989567afb183e9f86))
* **portfolio:** put the Children tabs on the shared grid shell ([#346](https://github.com/QNSC-VN/rally/issues/346)) ([c3afee8](https://github.com/QNSC-VN/rally/commit/c3afee8f8361d8652d52c2cc191a1902cb6fc3d3))
* **rally-parity:** first Phase 5/6 corrections against real Rally ([#383](https://github.com/QNSC-VN/rally/issues/383)) ([f5b764e](https://github.com/QNSC-VN/rally/commit/f5b764e51aef12f5741d9bbd5c16b2abc2b9eb27))
* **reporting:** give the Ideal baseline the team grain its snapshot rows already had ([#357](https://github.com/QNSC-VN/rally/issues/357)) ([0676c7b](https://github.com/QNSC-VN/rally/commit/0676c7ba520e9de69e4c0d146fc43a1cf1dd28c3))
* **reporting:** give the release Ideal target a team scope ([#362](https://github.com/QNSC-VN/rally/issues/362)) ([c72a9f0](https://github.com/QNSC-VN/rally/commit/c72a9f0dbdbbf3bb0a7e2f185d5570a649d8d694))
* **reporting:** page the Release Tracking list, and give the reports one composition ([#344](https://github.com/QNSC-VN/rally/issues/344)) ([833abf6](https://github.com/QNSC-VN/rally/commit/833abf6fbddba681ced546b5e9434d2f34bdf366))
* **reporting:** stop the snapshot job skipping workspaces, and mark partial captures ([#341](https://github.com/QNSC-VN/rally/issues/341)) ([53958f6](https://github.com/QNSC-VN/rally/commit/53958f65724abb81e980849c6f39859dfd47ccbb))
* **reports,releases,notifications,settings:** close eight audit-register findings and the review findings they attracted ([#427](https://github.com/QNSC-VN/rally/issues/427)) ([ca77d05](https://github.com/QNSC-VN/rally/commit/ca77d059014009a55ef7efff48743432dd3094fe))
* **reports:** absent data renders as absent, not as a measured zero ([#360](https://github.com/QNSC-VN/rally/issues/360)) ([8fc332a](https://github.com/QNSC-VN/rally/commit/8fc332ac488031630ca0057d2ffe2033156c0bca))
* **reports:** give burndown history a team, and the snapshot tables their keys ([#332](https://github.com/QNSC-VN/rally/issues/332)) ([aac64c6](https://github.com/QNSC-VN/rally/commit/aac64c6266774780dfdf84e8822973e55f5e7e48))
* **reports:** make Phase 6 reachable, and make it render ([#330](https://github.com/QNSC-VN/rally/issues/330)) ([fee423d](https://github.com/QNSC-VN/rally/commit/fee423dc6d6012e4919b6aedaf601891ff4b8610))
* **reports:** scope reports by the work's team, not by the timebox ([#331](https://github.com/QNSC-VN/rally/issues/331)) ([c9334fb](https://github.com/QNSC-VN/rally/commit/c9334fb5b3bb4250b1348dc0bb8308b5ea055b2e))
* stop the idle production database daily, not weekly ([#413](https://github.com/QNSC-VN/rally/issues/413)) ([ed39201](https://github.com/QNSC-VN/rally/commit/ed39201386dabd11165472c419d8f575250a7009))
* **team-status:** make Team Status and Team Capacity report the same hours ([#350](https://github.com/QNSC-VN/rally/issues/350)) ([a0fbb1d](https://github.com/QNSC-VN/rally/commit/a0fbb1df08519d4c666eba4f7d95c60dfa3f3ca5))
* unblock main — team-status actualHours typo + js-yaml 4.3.1 floor ([#405](https://github.com/QNSC-VN/rally/issues/405)) ([aba979e](https://github.com/QNSC-VN/rally/commit/aba979e905a2c29d8cf0541f29ccf6cdae6b0de8))
* **web,infra:** make every non-admin role behave as the BA specified, and make email possible ([#430](https://github.com/QNSC-VN/rally/issues/430)) ([ec5d076](https://github.com/QNSC-VN/rally/commit/ec5d0767b5b2b24c393f72e439e2406f3e8aea09))
* **web:** join the detail tabs to their header, and share the project cell ([#359](https://github.com/QNSC-VN/rally/issues/359)) ([004ee83](https://github.com/QNSC-VN/rally/commit/004ee83649dfd679ced57b41b36b454037537092))
* **web:** make rank reorder keyboard-operable, and stop two placeholders meaning one thing ([#355](https://github.com/QNSC-VN/rally/issues/355)) ([a10ce5b](https://github.com/QNSC-VN/rally/commit/a10ce5b02549a7b872a1575d1fa6ba588cb86e85))
* **web:** match Rally on the capacity team tab and Release Tracking ([#377](https://github.com/QNSC-VN/rally/issues/377)) ([cc437e5](https://github.com/QNSC-VN/rally/commit/cc437e5fd81c114b394258751b8ed2ca700e9f67))
* **web:** move dnd attributes to the grip on the last four grids ([#356](https://github.com/QNSC-VN/rally/issues/356)) ([4bbf154](https://github.com/QNSC-VN/rally/commit/4bbf1547cdc16b3a19b7037d6aa38ca5aa57672e))
* **web:** name the default report scope, and make the shared grids sortable by keyboard ([#343](https://github.com/QNSC-VN/rally/issues/343)) ([2ac12cb](https://github.com/QNSC-VN/rally/commit/2ac12cb4c563f26dad7ad5452858231225cdf1b8))
* **web:** one drag grip everywhere, hover-revealed, with shared entity cells ([#374](https://github.com/QNSC-VN/rally/issues/374)) ([c004436](https://github.com/QNSC-VN/rally/commit/c0044366fdebb583d2cdcbd53a60a054d34539a8))
* **web:** put Release Tracking on the shared toolbar and fix an em-dash placeholder ([#365](https://github.com/QNSC-VN/rally/issues/365)) ([4dc7c10](https://github.com/QNSC-VN/rally/commit/4dc7c10c8fe0835fd807c6da08dda6f29880fbdc))
* **work-items:** a task's iteration is derived from its parent, not owned ([#345](https://github.com/QNSC-VN/rally/issues/345)) ([f0b20fe](https://github.com/QNSC-VN/rally/commit/f0b20feb94faa5df1dd2ce6b9621d85f0b726cb7))
* **work-items:** hold two derived rules as invariants, not as one write's hook ([#351](https://github.com/QNSC-VN/rally/issues/351)) ([741201d](https://github.com/QNSC-VN/rally/commit/741201d957067756e016924591527eccf7c02687))
* **work-items:** the first Estimate copies to To Do, and archive order cuts both ways ([#339](https://github.com/QNSC-VN/rally/issues/339)) ([c3b86d0](https://github.com/QNSC-VN/rally/commit/c3b86d0cb05ed5727a90d3c2ba92834cd3023521))


### ⚡ Performance

* **infra:** bundle develop's app secrets into one Secrets Manager container ([#313](https://github.com/QNSC-VN/rally/issues/313)) ([17df48e](https://github.com/QNSC-VN/rally/commit/17df48e610e4308bc815adeef3089d3178210391))
* **infra:** bundle production's app secrets, and price the go-live delta ([#316](https://github.com/QNSC-VN/rally/issues/316)) ([e28c046](https://github.com/QNSC-VN/rally/commit/e28c04618876b67d4b21adb2a5a5cd7cb54e8a44))
* **infra:** drop develop's standalone secrets, completing the bundle migration ([#314](https://github.com/QNSC-VN/rally/issues/314)) ([898c6b0](https://github.com/QNSC-VN/rally/commit/898c6b068b290a4bf19528627984fdf5ef0238c8))
* **infra:** right-size the production api task ([#436](https://github.com/QNSC-VN/rally/issues/436)) ([bf518c1](https://github.com/QNSC-VN/rally/commit/bf518c101bf4137ac65336c67f3d591e174b2822))
* **infra:** run rally develop on Graviton ([#447](https://github.com/QNSC-VN/rally/issues/447)) ([e6c9a27](https://github.com/QNSC-VN/rally/commit/e6c9a27064476bb65cc4c6378f257cfde92ae6df))
* **infra:** stop develop twice nightly, at 21:00 and 03:00 ([#320](https://github.com/QNSC-VN/rally/issues/320)) ([78470f2](https://github.com/QNSC-VN/rally/commit/78470f26bf304c8825fc75c6dfb1efb0d964eb8c))


### ♻️ Refactors

* **scheduling:** share one ExclusiveJob helper, and stop a cache outage silencing every cron ([#409](https://github.com/QNSC-VN/rally/issues/409)) ([4af4593](https://github.com/QNSC-VN/rally/commit/4af4593c00de4820ff8296014df6df38b4243048))
* **web:** five surfaces onto the shared primitives they already had ([#370](https://github.com/QNSC-VN/rally/issues/370)) ([573f54d](https://github.com/QNSC-VN/rally/commit/573f54d25f34023ed3f00e5a2608068d59cb6304))
* **web:** one Rank column, and give the Children tab the one it was missing ([#361](https://github.com/QNSC-VN/rally/issues/361)) ([788b941](https://github.com/QNSC-VN/rally/commit/788b94191da3d6f35c2d01dabd2ee6a7f53a28cc))
* **web:** one row, one cell, one size — shared grid chrome ([#381](https://github.com/QNSC-VN/rally/issues/381)) ([4a6e9a5](https://github.com/QNSC-VN/rally/commit/4a6e9a539ab92988c49e7a2722572c44531b6ae3))
* **web:** one source for column sizing, deleting five hand-built copies ([#354](https://github.com/QNSC-VN/rally/issues/354)) ([ae33447](https://github.com/QNSC-VN/rally/commit/ae334477ef393ad56d80b0157c011ab0cff9dfff))
* **web:** remove the Defects tab and align Tasks/Epic Children on one grid ([#364](https://github.com/QNSC-VN/rally/issues/364)) ([0894269](https://github.com/QNSC-VN/rally/commit/08942695ad66fd9030169ec4fbdeadb0130f09bd))


### 🔒 Security

* **access:** bind an invitation to its address, and stop gates denying the roles they should allow ([#349](https://github.com/QNSC-VN/rally/issues/349)) ([83dc31a](https://github.com/QNSC-VN/rally/commit/83dc31a905b3de7a4a824ef80eee825cfaaabad4))
* **authz:** close the access-model P0s, restore Viewer, and fix the timebox/backlog population bugs ([#426](https://github.com/QNSC-VN/rally/issues/426)) ([0ba64fe](https://github.com/QNSC-VN/rally/commit/0ba64fefed681315f268ee92199b389fbbe66f69))
* **authz:** deny routes that declare no authorization, and refuse to boot on one ([#410](https://github.com/QNSC-VN/rally/issues/410)) ([25527f7](https://github.com/QNSC-VN/rally/commit/25527f78e8b4fa57d24e2300ff53f46275421366))
* **identity:** bind invitation acceptance to the guest's directory object ([#439](https://github.com/QNSC-VN/rally/issues/439)) ([6e85197](https://github.com/QNSC-VN/rally/commit/6e8519716c9eebf28dbcacb6fca6585cf4742d48))
* **projects:** scope the project list and roster to what the caller may read ([#352](https://github.com/QNSC-VN/rally/issues/352)) ([f74c2c8](https://github.com/QNSC-VN/rally/commit/f74c2c8a7c981fc4f9f69a90c6b573fb8ceaed91))

## [0.6.1](https://github.com/QNSC-VN/rally/compare/v0.6.0...v0.6.1) (2026-07-31)


### ✨ Features

* **capacity:** add Rally's Items tab, and move the cutline onto it ([#291](https://github.com/QNSC-VN/rally/issues/291)) ([20f59ad](https://github.com/QNSC-VN/rally/commit/20f59ad685c00cb3ef5132f2fff4ffdc77af1bb0))
* **capacity:** disclose a team's Features, as Rally does ([#292](https://github.com/QNSC-VN/rally/issues/292)) ([3d69b22](https://github.com/QNSC-VN/rally/commit/3d69b2238b6416e19c492c042105a24c772a9cf4))
* **capacity:** draw Rally's cutline, per team ([#285](https://github.com/QNSC-VN/rally/issues/285)) ([b288912](https://github.com/QNSC-VN/rally/commit/b2889126272b34fccc23892db7c10cabf129c48c))
* **capacity:** lay the plan list out as Rally does ([#298](https://github.com/QNSC-VN/rally/issues/298)) ([e15d350](https://github.com/QNSC-VN/rally/commit/e15d350b6db38adba511d6b1da963bdbc0d2bc08))
* **capacity:** lay the Teams tab out as Rally does ([#297](https://github.com/QNSC-VN/rally/issues/297)) ([3f527ac](https://github.com/QNSC-VN/rally/commit/3f527acbcc087866df0541be7d129cf41d0f1716))
* **capacity:** record Rally's primary team assignment ([#294](https://github.com/QNSC-VN/rally/issues/294)) ([eceafba](https://github.com/QNSC-VN/rally/commit/eceafbafd9e8b9a377f31600ccf314cfe85cf89e))
* **capacity:** show Rally's plan summary strip on the plan detail ([#289](https://github.com/QNSC-VN/rally/issues/289)) ([ab369d6](https://github.com/QNSC-VN/rally/commit/ab369d6707b07f291172e77592f403f1de91e5eb))
* **work-items:** let a Story be linked to a Feature, and fix the drag flake ([#296](https://github.com/QNSC-VN/rally/issues/296)) ([dd1bdcf](https://github.com/QNSC-VN/rally/commit/dd1bdcfc4119cb59475120d40a4b2913b5a588cd))


### 🐛 Bug Fixes

* **infra:** stop the idled environments paging about being idle ([#288](https://github.com/QNSC-VN/rally/issues/288)) ([d0082a5](https://github.com/QNSC-VN/rally/commit/d0082a568251d5510381674b47ca58f51ba2976f))
* **work-items:** clear the Blocked Reason when an item is unblocked ([#287](https://github.com/QNSC-VN/rally/issues/287)) ([888c325](https://github.com/QNSC-VN/rally/commit/888c325e880815bfd53c40b180d81b5be7cd655c))


### ⚡ Performance

* **infra:** run the production worker on Fargate Spot ([#293](https://github.com/QNSC-VN/rally/issues/293)) ([6419130](https://github.com/QNSC-VN/rally/commit/6419130747d10347b75b0a3f69c5335b95bf53f2))


### ♻️ Refactors

* **capacity:** render Release with the Backlog's release cell ([#299](https://github.com/QNSC-VN/rally/issues/299)) ([19f0840](https://github.com/QNSC-VN/rally/commit/19f0840e1bddca42cbd0cf875292360626a57524))

## [0.6.0](https://github.com/QNSC-VN/rally/compare/v0.5.2...v0.6.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **config:** a deployed environment that does not inject REDIS_URL now fails to boot instead of running with sessions broken and two security controls failed open. That is the intent. Any consumer relying on the localhost default must set it explicitly.

### ✨ Features

* **capacity:** publish a plan onto its Features, and revert without undoing it ([#280](https://github.com/QNSC-VN/rally/issues/280)) ([7f0aa59](https://github.com/QNSC-VN/rally/commit/7f0aa591d1d6aab70813a0b9ca743d34afdc419f))


### 🐛 Bug Fixes

* **config:** require REDIS_URL, with no localhost fallback ([#283](https://github.com/QNSC-VN/rally/issues/283)) ([93e96a9](https://github.com/QNSC-VN/rally/commit/93e96a9c4f331d4e65ff966bf8a828ceb99fb11b))
* **web:** show a newly created row instead of hiding it on another page ([#284](https://github.com/QNSC-VN/rally/issues/284)) ([67a3b88](https://github.com/QNSC-VN/rally/commit/67a3b8877872a1308a9f8c4e6f624a0f8c80909b))

## [0.5.2](https://github.com/QNSC-VN/rally/compare/v0.5.1...v0.5.2) (2026-07-30)


### ✨ Features

* **capacity:** allocate Features to teams, with Rally's rollup rules ([#270](https://github.com/QNSC-VN/rally/issues/270)) ([b67f159](https://github.com/QNSC-VN/rally/commit/b67f159b9123bfb1994cbfd839d1d4dfdc434683))
* **capacity:** Calculate Capacity Forecast, Monte Carlo over accepted history ([#276](https://github.com/QNSC-VN/rally/issues/276)) ([4873d0d](https://github.com/QNSC-VN/rally/commit/4873d0d9afff37ee2c5abda78fa0a1b83cede7b0))
* **capacity:** capacity plans with team membership and manual capacity ([#269](https://github.com/QNSC-VN/rally/issues/269)) ([cd03ea0](https://github.com/QNSC-VN/rally/commit/cd03ea0f7bba9cea6180b083651ad149c6990f4f))
* **capacity:** explain the warnings, and add Rally's Breakdown ([#274](https://github.com/QNSC-VN/rally/issues/274)) ([d2b5774](https://github.com/QNSC-VN/rally/commit/d2b577474a933436f5e29a1afb1d276aeae87a74))
* **portfolio:** colour Percent Done by Rally status ([#273](https://github.com/QNSC-VN/rally/issues/273)) ([78cb2ac](https://github.com/QNSC-VN/rally/commit/78cb2acb3daddbfa2ae214531617f5790f033d71))
* **portfolio:** drag to reorder Epics and Features ([#265](https://github.com/QNSC-VN/rally/issues/265)) ([85dfe19](https://github.com/QNSC-VN/rally/commit/85dfe19caef90fbcab1a0faaf22fa91dc6528236))


### 🐛 Bug Fixes

* **infra:** idling must scale the services down, not just stop the database ([#279](https://github.com/QNSC-VN/rally/issues/279)) ([3658e8b](https://github.com/QNSC-VN/rally/commit/3658e8b97054dd3e8ab3aab987f5eeb783dbba5e))
* **work-items:** drop the dead hours columns from work_items ([#271](https://github.com/QNSC-VN/rally/issues/271)) ([75b68e1](https://github.com/QNSC-VN/rally/commit/75b68e1e9d0489df3655ab7f779d72a4048091f1))


### ⚡ Performance

* **web:** buffer the SCM webhook body at the edge before forwarding ([#267](https://github.com/QNSC-VN/rally/issues/267)) ([8ce0048](https://github.com/QNSC-VN/rally/commit/8ce004826d40ab3da77d589dac79b54cee9733e1))

## [0.5.1](https://github.com/QNSC-VN/rally/compare/v0.5.0...v0.5.1) (2026-07-29)


### ✨ Features

* **portfolio:** create, edit and archive Epics and Features ([#262](https://github.com/QNSC-VN/rally/issues/262)) ([1662b88](https://github.com/QNSC-VN/rally/commit/1662b8882be5bee07dbfd5d3f7d13028adf88ede))


### 🐛 Bug Fixes

* **observability:** attribute request latency to the interval that caused it ([#264](https://github.com/QNSC-VN/rally/issues/264)) ([dbd9fe3](https://github.com/QNSC-VN/rally/commit/dbd9fe33af2b80fca8d1b854fef33f6e1199810c))

## [0.5.0](https://github.com/QNSC-VN/rally/compare/v0.4.1...v0.5.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* **work-items:** a Feature is a portfolio item, not a work item ([#256](https://github.com/QNSC-VN/rally/issues/256))

### ✨ Features

* **portfolio:** epic/feature list and detail on the P5 backend ([#261](https://github.com/QNSC-VN/rally/issues/261)) ([cb44359](https://github.com/QNSC-VN/rally/commit/cb4435937887ef9f7de48846ab6c2cdd5973f031))
* **portfolio:** P5 schema, permissions and progress arithmetic ([#254](https://github.com/QNSC-VN/rally/issues/254)) ([21ef681](https://github.com/QNSC-VN/rally/commit/21ef681c29b41b43278a0efd6621d6c7af68b795))
* **portfolio:** portfolio item read paths with cross-project authorization ([#257](https://github.com/QNSC-VN/rally/issues/257)) ([6d66a61](https://github.com/QNSC-VN/rally/commit/6d66a617d302db3b3cc294ba4e428c80823c7d4e))


### 🐛 Bug Fixes

* **infra:** actually wire the API autoscaling targets through the stack module ([#258](https://github.com/QNSC-VN/rally/issues/258)) ([e7bab36](https://github.com/QNSC-VN/rally/commit/e7bab36b9d25f0bbb3479de104ea0f3aa6916329))
* **infra:** stop the ALB latency alarm paging on noise, and bound the DB pool ([#260](https://github.com/QNSC-VN/rally/issues/260)) ([1f7d322](https://github.com/QNSC-VN/rally/commit/1f7d3223e04a4f75c9ea5c8658eec4c99018ec77))
* **web:** stop dropping Set-Cookie when the runtime has no getSetCookie ([#259](https://github.com/QNSC-VN/rally/issues/259)) ([f9c5751](https://github.com/QNSC-VN/rally/commit/f9c5751d7cb5a93db2ab2e7a7871bd2ca3218d24))


### ♻️ Refactors

* **work-items:** a Feature is a portfolio item, not a work item ([#256](https://github.com/QNSC-VN/rally/issues/256)) ([b397157](https://github.com/QNSC-VN/rally/commit/b397157bbc93f322c58dafd1cb28bd236371a54c))

## [0.4.1](https://github.com/QNSC-VN/rally/compare/v0.4.0...v0.4.1) (2026-07-29)


### ✨ Features

* **infra:** move production's api and worker off the RDS master credential ([#251](https://github.com/QNSC-VN/rally/issues/251)) ([fb8be77](https://github.com/QNSC-VN/rally/commit/fb8be779bdd50da55c9b2844f4eaf8d166deeebc))

## [0.4.0](https://github.com/QNSC-VN/rally/compare/v0.3.3...v0.4.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* **access:** access tokens no longer contain `claims.permissions` or `claims.authzEpoch`, and `TOKEN_STALE` is never returned. Any client branching on that response code can drop the branch; permissions for UI gating come from `/v1/bff/me`, which resolves through the same path the guard uses and is unchanged. Tokens minted before this deploy keep working — their extra claims are simply ignored.

### ✨ Features

* **db:** run the least-privilege role cutover as a one-off migrator task ([09f8969](https://github.com/QNSC-VN/rally/commit/09f89697c081eeb2700b9d1c0bd1fe63fc3c814f))
* **infra:** inject CDN_PUBLIC_ASSETS_BASE_URL for avatars and workspace logos ([bb1f64b](https://github.com/QNSC-VN/rally/commit/bb1f64b47f83a5566780ecfeb2e3c88623689e23))
* **infra:** move develop's api and worker off the RDS master credential ([cf3d092](https://github.com/QNSC-VN/rally/commit/cf3d092f3d920acf689cf790a66c8cdcf6e6f926))


### 🐛 Bug Fixes

* **ci:** stop an unapproved prod infra apply from blocking every develop apply ([d5db9f6](https://github.com/QNSC-VN/rally/commit/d5db9f6e181de6d10a5302b7f716e7426d20f8d2))
* **db:** drop the last two RLS policies, which deny every file write ([120448c](https://github.com/QNSC-VN/rally/commit/120448ce9bc4f72019eec4a9f82a0f4da782cbd4))
* **infra:** inject the public-bucket R2 credential in both environments ([49b37d8](https://github.com/QNSC-VN/rally/commit/49b37d894a2188aef18bbbc5a8cdc6dcb7958c0e))
* **scm:** wire production's GitHub App id — SCM was silently dormant ([46b00f8](https://github.com/QNSC-VN/rally/commit/46b00f82473f295d4e728dc9238be9ead95fe3d8))
* **web:** allow the public-asset origins in the CSP img-src directive ([83c39bd](https://github.com/QNSC-VN/rally/commit/83c39bd644f66cf5898687afd5605f783210ebb2))


### ♻️ Refactors

* **access:** resolve permissions from the database, delete the authz epoch ([7add892](https://github.com/QNSC-VN/rally/commit/7add892ecec7cadf4aae7027c94dc9277594acf0))

## [0.3.3](https://github.com/QNSC-VN/rally/compare/v0.3.2...v0.3.3) (2026-07-28)


### ♻️ Refactors

* **access:** one authorization decision point — retire the legacy permission path ([d69221a](https://github.com/QNSC-VN/rally/commit/d69221a00f8c968c79748c05c5bef0aa87693362))
* **access:** retire the legacy permission path ([a3a4571](https://github.com/QNSC-VN/rally/commit/a3a4571aad8e41cbc6f12baccb984cbc2675bd83))
* **scm:** move SCM routes onto the single PolicyGuard ([a883b71](https://github.com/QNSC-VN/rally/commit/a883b7195a0c12b34956bc53168d9ce0e5636a71))

## [0.3.2](https://github.com/QNSC-VN/rally/compare/v0.3.1...v0.3.2) (2026-07-28)


### ✨ Features

* **access:** make project_admin + project_member workspace-editable ([#216](https://github.com/QNSC-VN/rally/issues/216)) ([cb1ac7c](https://github.com/QNSC-VN/rally/commit/cb1ac7c96888b4465e0582adf520a2800bc012ba))
* **backlog:** wire bulk Assign Release/Iteration into the bulk bar ([#219](https://github.com/QNSC-VN/rally/issues/219)) ([930adf2](https://github.com/QNSC-VN/rally/commit/930adf231b868ea7a4a6c1869f2800bfe2463ff4))
* **settings:** show weekday + seconds in the Audit Log timestamp ([#220](https://github.com/QNSC-VN/rally/issues/220)) ([7ae7fbc](https://github.com/QNSC-VN/rally/commit/7ae7fbcdff330dd487910f34edee9794b806dc92))


### 🐛 Bug Fixes

* **api:** deterministic ordering, working cursor pagination, race-free ranks ([#232](https://github.com/QNSC-VN/rally/issues/232)) ([2b161a1](https://github.com/QNSC-VN/rally/commit/2b161a18db43142ea669830aace7ba0777111e60))
* **ci:** align every qnsc-ci pin to v1.6.2 and guard the run-lookup retries ([#229](https://github.com/QNSC-VN/rally/issues/229)) ([51d377d](https://github.com/QNSC-VN/rally/commit/51d377dc517aa8e44fccf7dea78116f3d8b0112a))
* **ci:** bump qnsc-ci reusable to v1.6.2 ([#225](https://github.com/QNSC-VN/rally/issues/225)) ([13d1070](https://github.com/QNSC-VN/rally/commit/13d10701a7d6ccbca97b588a0d03de304df84b34))
* cost-posture pass — Container Insights, pre-launch RDS, ARM64, derived JWT public key ([#224](https://github.com/QNSC-VN/rally/issues/224)) ([a93d75b](https://github.com/QNSC-VN/rally/commit/a93d75bd76afccd60af66f16ccd3e781cfd6df42))
* **db:** defer the rally_migrate default privileges to cutover ([#228](https://github.com/QNSC-VN/rally/issues/228)) ([9698f50](https://github.com/QNSC-VN/rally/commit/9698f50124587789ecff7545f427a5de4eab1a8a))
* **infra:** adopt ecr-v2.0.0 so the lifecycle policy actually prunes ([#230](https://github.com/QNSC-VN/rally/issues/230)) ([696a458](https://github.com/QNSC-VN/rally/commit/696a4588379d2ecf30e7a2b428c90755724adc43))
* **infra:** revert Fargate to x86 — ARM64 Spot has no capacity ([#227](https://github.com/QNSC-VN/rally/issues/227)) ([06aed86](https://github.com/QNSC-VN/rally/commit/06aed86a98db6905f711c7355cf0a2a27ea5730c))
* **infra:** stop injecting JWT_PUBLIC_KEY — phase 2 of its retirement ([#233](https://github.com/QNSC-VN/rally/issues/233)) ([5ca2ba1](https://github.com/QNSC-VN/rally/commit/5ca2ba17c04a38787e29a0712acf175a1aad6ddc))
* **web:** align iteration status flow state, WA account guard, team status + rally-parity polish ([#221](https://github.com/QNSC-VN/rally/issues/221)) ([92e5e07](https://github.com/QNSC-VN/rally/commit/92e5e073097fb31319fdaf4fd05046ea3a0d7b43))
* **web:** confirm every destructive action; drop native prompts ([#218](https://github.com/QNSC-VN/rally/issues/218)) ([ea31f0c](https://github.com/QNSC-VN/rally/commit/ea31f0cd359f51367a57731036734bf334b56e21))
* **web:** remove workspace switcher (single-company MVP) ([#215](https://github.com/QNSC-VN/rally/issues/215)) ([cfd02ff](https://github.com/QNSC-VN/rally/commit/cfd02ff490eb29fdb6f7ce7f292214aad01308bd))
* **work-items:** reopening a child task reverts an Accepted parent to In-Progress ([#222](https://github.com/QNSC-VN/rally/issues/222)) ([d422ba7](https://github.com/QNSC-VN/rally/commit/d422ba7db80a5ba76d4001c22ec2dc3557ef263f))


### 🔒 Security

* **db:** least-privilege DB roles, workspace/project isolation ratchets ([#226](https://github.com/QNSC-VN/rally/issues/226)) ([2459152](https://github.com/QNSC-VN/rally/commit/2459152816ad2fef2bad16692f3257a5c0e651ef))
* **storage:** separate the public-bucket credential from the private one ([#231](https://github.com/QNSC-VN/rally/issues/231)) ([5c6ce15](https://github.com/QNSC-VN/rally/commit/5c6ce15f6040729d011562d9c30daa1fa0109cdf))

## [0.3.1](https://github.com/QNSC-VN/rally/compare/v0.3.0...v0.3.1) (2026-07-27)


### ✨ Features

* **access:** [P2] migrate projects/workflow/quality/access onto PolicyGuard ([#199](https://github.com/QNSC-VN/rally/issues/199)) ([0fc050e](https://github.com/QNSC-VN/rally/commit/0fc050eae0b55241f74c99f9e3e1524c41a91cfa))
* **access:** [P2] migrate reporting/collaboration/team-status onto PolicyGuard ([#203](https://github.com/QNSC-VN/rally/issues/203)) ([3e73fb1](https://github.com/QNSC-VN/rally/commit/3e73fb1613a512be9b72a58f913f531fa8910c8d))
* **access:** [P2] migrate work-items onto the single PolicyGuard ([#198](https://github.com/QNSC-VN/rally/issues/198)) ([23fe903](https://github.com/QNSC-VN/rally/commit/23fe9039a0dd3780fbbbe03ae2b51d8c1447d9d1))
* **access:** custom roles — backend CRUD (Phase 1) ([#207](https://github.com/QNSC-VN/rally/issues/207)) ([911860a](https://github.com/QNSC-VN/rally/commit/911860a584ffd06019352e11c9bd45fa3e312264))
* **infra:** wire the OpenTelemetry collector so telemetry can be switched on ([#211](https://github.com/QNSC-VN/rally/issues/211)) ([c9535a7](https://github.com/QNSC-VN/rally/commit/c9535a7ff55ab5f2b18efe72e122a8d18cf93ee8))
* **web:** consistent settings tab headers, identity cells and roles polish ([#201](https://github.com/QNSC-VN/rally/issues/201)) ([1f04076](https://github.com/QNSC-VN/rally/commit/1f04076b6cb96022ac9aaf2386932e2e9532b6c0))
* **web:** custom roles editor — inline matrix (Phase 2) ([#213](https://github.com/QNSC-VN/rally/issues/213)) ([ae1695b](https://github.com/QNSC-VN/rally/commit/ae1695bcc68dcc66b2ed088354f9ec14f79cf79d))
* **web:** unify Integrations sections on the Card standard ([#206](https://github.com/QNSC-VN/rally/issues/206)) ([7d9f69c](https://github.com/QNSC-VN/rally/commit/7d9f69c302853c493c01d56386d85fc5e03c8204))
* **workspace:** resend workspace invitation ([#209](https://github.com/QNSC-VN/rally/issues/209)) ([b319090](https://github.com/QNSC-VN/rally/commit/b31909091203c854fadd4439237ba1ed4fe019ed))


### 🐛 Bug Fixes

* **web:** drop redundant timebox Type selector + unify History tab label ([#214](https://github.com/QNSC-VN/rally/issues/214)) ([0aece0b](https://github.com/QNSC-VN/rally/commit/0aece0b1095bdf70f4fced3df895c8ba905d5a6a))
* **web:** route modal server errors to a form-level banner ([#196](https://github.com/QNSC-VN/rally/issues/196)) ([486c1b3](https://github.com/QNSC-VN/rally/commit/486c1b30a164606de6816a01c31ab96d1a4b94a4))


### ♻️ Refactors

* **access:** [P2] delete the dead ProjectPermissionGuard ([#204](https://github.com/QNSC-VN/rally/issues/204)) ([6e8c322](https://github.com/QNSC-VN/rally/commit/6e8c322f7a89e90da67dd47d96d8b56bcbce8ad8))
* **web:** standardize fonts on the ui type scale + ratchet ([#202](https://github.com/QNSC-VN/rally/issues/202)) ([9c289f9](https://github.com/QNSC-VN/rally/commit/9c289f924ace0c90648e650ea34fb49866a6ee8a))

## [0.3.0](https://github.com/QNSC-VN/rally/compare/v0.2.4...v0.3.0) (2026-07-27)


### ⚠ BREAKING CHANGES

* **infra:** develop's cache node is REPLACED, which drops every develop session. BFF sessions live only in the cache, so all develop users must sign in again. Production is unaffected: moved.tf relocates module.cache to module.stack.module.cache as state-only, so its replication group, subnet group and KMS association are untouched.
* **access:** reconcile RBAC — fix read leaks, 3-role model, catalog + capability viewer ([#183](https://github.com/QNSC-VN/rally/issues/183))

### ✨ Features

* **access:** single PolicyGuard core + migrate releases/milestones/iterations (P2) ([#190](https://github.com/QNSC-VN/rally/issues/190)) ([64343ce](https://github.com/QNSC-VN/rally/commit/64343ce63cae2debef132bb1f9d51dc8319fc6f6))
* **web:** enterprise-consistent Settings + shared grid/cell polish ([#184](https://github.com/QNSC-VN/rally/issues/184)) ([53cc180](https://github.com/QNSC-VN/rally/commit/53cc18013b1663d58d83041659b26f586c471ee1))


### 🐛 Bug Fixes

* **access:** update audit-controller authz test to audit:view ([#188](https://github.com/QNSC-VN/rally/issues/188)) ([5d1ab26](https://github.com/QNSC-VN/rally/commit/5d1ab261ae04228e70bc2764b87435d367d43441))
* **iterations:** include team-less iterations in the assignment picker ([#194](https://github.com/QNSC-VN/rally/issues/194)) ([e398467](https://github.com/QNSC-VN/rally/commit/e398467656dd121d9854fef321b8ef2c4c9e7d2f))
* **web:** modal validation errors under their own field + UIUX consistency pass ([#195](https://github.com/QNSC-VN/rally/issues/195)) ([710911a](https://github.com/QNSC-VN/rally/commit/710911a57e868b3a2e23f233027499ae865f112c))
* **web:** show 0 for zero hours instead of em dash ([#193](https://github.com/QNSC-VN/rally/issues/193)) ([4b9ed99](https://github.com/QNSC-VN/rally/commit/4b9ed991df464e7fab3a59a9394722316843fd5f))


### ♻️ Refactors

* **access:** reconcile RBAC — fix read leaks, 3-role model, catalog + capability viewer ([#183](https://github.com/QNSC-VN/rally/issues/183)) ([0e476a3](https://github.com/QNSC-VN/rally/commit/0e476a3e823d2e9b06775d95cef22a6bf89be3fc))
* **infra:** unify the cache into the stack module, harden prod RDS ([#191](https://github.com/QNSC-VN/rally/issues/191)) ([f73abb7](https://github.com/QNSC-VN/rally/commit/f73abb730e21cbaf384e4ed6f5ca9a046128e679))

## [0.2.4](https://github.com/QNSC-VN/rally/compare/v0.2.3...v0.2.4) (2026-07-26)


### ✨ Features

* **activity:** shared Revision History primitive + expand to all entities ([#174](https://github.com/QNSC-VN/rally/issues/174)) ([25be40a](https://github.com/QNSC-VN/rally/commit/25be40a2b3d46c57cde8a7fb0cfcc0ff9ae067df))
* align app with BA SRS and unify entity detail pages ([#128](https://github.com/QNSC-VN/rally/issues/128)) ([7074023](https://github.com/QNSC-VN/rally/commit/7074023705c54dcfbc472de11bfdcf6cd48ff873))
* build Teams & Users management (Module 08) + unify form-control styling ([#134](https://github.com/QNSC-VN/rally/issues/134)) ([cc3139d](https://github.com/QNSC-VN/rally/commit/cc3139d15a089654aae3ca52634f5cd36d8a62f8))
* **identity:** home SSO shortcut + invite-only access; drop legacy login (T18) ([#144](https://github.com/QNSC-VN/rally/issues/144)) ([33e1c66](https://github.com/QNSC-VN/rally/commit/33e1c668825ff79e8b46472b7f855028276c6e66))
* **identity:** multi-IdP OIDC broker — email-first login + Secrets Manager ([#140](https://github.com/QNSC-VN/rally/issues/140)) ([8786359](https://github.com/QNSC-VN/rally/commit/8786359509cd7001062517136badd2ebc5ec21fb))
* **infra:** adopt the shared observability module, drop the duplicate alert topic ([#172](https://github.com/QNSC-VN/rally/issues/172)) ([5fc6d1e](https://github.com/QNSC-VN/rally/commit/5fc6d1e5a692831115e469850dbcd8a14c3051fe))
* **infra:** dedicate rally prod cache per product ([#109](https://github.com/QNSC-VN/rally/issues/109)) ([9a185ea](https://github.com/QNSC-VN/rally/commit/9a185eaeaf092ae7b74b879bb05f4fa0f0e96f67))
* **infra:** grant api task role runtime read of broker OIDC secrets ([#141](https://github.com/QNSC-VN/rally/issues/141)) ([a5858d4](https://github.com/QNSC-VN/rally/commit/a5858d4bcc426ff32606d485ac0a8e140f057704))
* **infra:** wire GitHub App secrets + config for SCM backfill (develop + prod) ([#146](https://github.com/QNSC-VN/rally/issues/146)) ([04c047f](https://github.com/QNSC-VN/rally/commit/04c047f788ddb26add837ff580850f0d9263663e))
* **observability:** fail-open alarming, Swagger/CSP split, and the observability architecture ([#162](https://github.com/QNSC-VN/rally/issues/162)) ([c9a75aa](https://github.com/QNSC-VN/rally/commit/c9a75aa169cf1932432f63fab48c55b6c0fc6220))
* **projects:** detail page + list refactor to the shared entity template ([#153](https://github.com/QNSC-VN/rally/issues/153)) ([7b0aec7](https://github.com/QNSC-VN/rally/commit/7b0aec7896ac51ec67f4b2b6e5fe52cf0a93fa54))
* **projects:** project end date + start/end range validation ([#179](https://github.com/QNSC-VN/rally/issues/179)) ([b98ff81](https://github.com/QNSC-VN/rally/commit/b98ff81c47d17a3b81fa435762ce262158231bbd))
* **rally:** close BA E2E gaps + FE table DRY refactor ([#111](https://github.com/QNSC-VN/rally/issues/111)) ([21b865b](https://github.com/QNSC-VN/rally/commit/21b865b2b64de76fcef2d74b8559c461c219edea))
* **rich-text:** selectable + mouse-resizable images in the editor ([#166](https://github.com/QNSC-VN/rally/issues/166)) ([f97e74e](https://github.com/QNSC-VN/rally/commit/f97e74ea30818555ff904cf66dd36b8cc5fe5551))
* **scm:** connections tab — link GitHub PRs & commits to work items ([#143](https://github.com/QNSC-VN/rally/issues/143)) ([2ffe6f7](https://github.com/QNSC-VN/rally/commit/2ffe6f70f0019d53e234fae80a9f0e2361629de7))
* **scm:** org-level github app auto-discovery + integrations dashboard ([#155](https://github.com/QNSC-VN/rally/issues/155)) ([442d015](https://github.com/QNSC-VN/rally/commit/442d0157f844e6cc56e6030adf6614d60972d18d))
* **scm:** paginate the repository table + exclude archived repos ([#168](https://github.com/QNSC-VN/rally/issues/168)) ([2fef17a](https://github.com/QNSC-VN/rally/commit/2fef17a3b11902892ed0a9e4ae4a596eb7d9a393))
* **scm:** phase 2 — GitHub App backfill + pgEnum schema + list-parity tables ([#145](https://github.com/QNSC-VN/rally/issues/145)) ([a62c76b](https://github.com/QNSC-VN/rally/commit/a62c76beba70ad5fd686bd1faae043dc2fe1c56d))
* **seed:** clean QNSC dev baseline + one-project fixture + e2e golden journey ([#160](https://github.com/QNSC-VN/rally/issues/160)) ([dc45cc5](https://github.com/QNSC-VN/rally/commit/dc45cc5a9cec746f84fb1ce834576b273e439e2b))
* **settings:** make timezone + locale actually drive date formatting ([#180](https://github.com/QNSC-VN/rally/issues/180)) ([f621d7d](https://github.com/QNSC-VN/rally/commit/f621d7d8290370bdd94ac7866348b048137c85e5))
* **ui:** searchable Show Fields column chooser (real-Rally Show Columns) ([#169](https://github.com/QNSC-VN/rally/issues/169)) ([d46a2c9](https://github.com/QNSC-VN/rally/commit/d46a2c9044e32370f6aecf1e94e074a903ef14b3))
* **ui:** whole ID cell (icon + key) is clickable to open the item ([#170](https://github.com/QNSC-VN/rally/issues/170)) ([a7a01d0](https://github.com/QNSC-VN/rally/commit/a7a01d0a6e07209b2d58f26af0e05d212297b162))
* **web:** frontend component-system migration (P0-P4) — tokens, decomposition, tables, i18n ([#112](https://github.com/QNSC-VN/rally/issues/112)) ([e140754](https://github.com/QNSC-VN/rally/commit/e140754be0df932f79bd657628d82b5c0dbf4b0d))
* **web:** paste-to-upload images in rich text + page-level Save/Cancel bar ([#123](https://github.com/QNSC-VN/rally/issues/123)) ([0e2f426](https://github.com/QNSC-VN/rally/commit/0e2f426caecbd27159b43740a6e4ec5cf02828fc))
* **web:** unify Releases and Milestones under the Timeboxes screen (DEV-004) ([#124](https://github.com/QNSC-VN/rally/issues/124)) ([23711de](https://github.com/QNSC-VN/rally/commit/23711de67a8f4b36a21f8b09ac4af6dcfb822b25))
* **work-items:** blocked schedule-state stepper turns red ([#178](https://github.com/QNSC-VN/rally/issues/178)) ([c9969b0](https://github.com/QNSC-VN/rally/commit/c9969b0ad745348bdfa2f6e4d8d899ce2b071773))
* **work-items:** hover-to-preview the schedule-state stepper (real-Rally feel) ([#175](https://github.com/QNSC-VN/rally/issues/175)) ([da23081](https://github.com/QNSC-VN/rally/commit/da230818824a049c6c5e9146ab1eba604cd4b871))
* **work-items:** real-Rally task time — independent Estimate, To Do zeroes on Complete ([#161](https://github.com/QNSC-VN/rally/issues/161)) ([24b4386](https://github.com/QNSC-VN/rally/commit/24b4386efcf5cfbd7e11f803338950b72d53eeee))
* **work-items:** rebuild attachment uploads on shared storage layer ([#114](https://github.com/QNSC-VN/rally/issues/114)) ([6246067](https://github.com/QNSC-VN/rally/commit/624606731ce2a869ebdf60602c9551599265e38c))
* **work-items:** workspace-unique keys (Rally FormattedID) + org-level SCM ([#154](https://github.com/QNSC-VN/rally/issues/154)) ([36c9c4d](https://github.com/QNSC-VN/rally/commit/36c9c4d104a974556e9c119b6ab0cf66c50fd67d))


### 🐛 Bug Fixes

* **auth:** enforce CSRF protection instead of only registering it ([#157](https://github.com/QNSC-VN/rally/issues/157)) ([bbccaba](https://github.com/QNSC-VN/rally/commit/bbccabab7bd384fa82f34c7e290a8c2637cfdb8e))
* **auth:** invalidate access tokens when permissions change ([#156](https://github.com/QNSC-VN/rally/issues/156)) ([b18f900](https://github.com/QNSC-VN/rally/commit/b18f90016f65503a1e00e639cfbc15317ccf3f0a))
* **ci:** bump qnsc-ci web-deploy pin to v1.4.1 ([#126](https://github.com/QNSC-VN/rally/issues/126)) ([a493711](https://github.com/QNSC-VN/rally/commit/a493711069ec27c8177e9309335309fad5f5e003))
* **db:** read credentials from the RDS-managed secret, not a copy ([#115](https://github.com/QNSC-VN/rally/issues/115)) ([eb37211](https://github.com/QNSC-VN/rally/commit/eb372114857fb31fa993c636953b552a72490ba1))
* **infra:** give the migrator the broker home-connection env ([#142](https://github.com/QNSC-VN/rally/issues/142)) ([06df0a1](https://github.com/QNSC-VN/rally/commit/06df0a1ceabe98951899f8a82341abfe8183156d))
* **infra:** grant the API task role GetSecretValue on github-app-private-key ([#165](https://github.com/QNSC-VN/rally/issues/165)) ([8f1919e](https://github.com/QNSC-VN/rally/commit/8f1919edfe5a200d029eedf96ea7a06508680582))
* **infra:** wire GitHub App creds into the API task (org-level auto-discovery) ([#163](https://github.com/QNSC-VN/rally/issues/163)) ([65e2650](https://github.com/QNSC-VN/rally/commit/65e2650e1f45b3df4a3bd5ceb1cff821525e92d2))
* **notifications:** close transaction, preference, and retry gaps in the outbox pipeline ([#117](https://github.com/QNSC-VN/rally/issues/117)) ([2c8c9c6](https://github.com/QNSC-VN/rally/commit/2c8c9c660f1baa1964e49608dc7f2f993a18d6d2))
* **outbox:** make relay() guarantee forward progress instead of a silent no-op ([#127](https://github.com/QNSC-VN/rally/issues/127)) ([01a5920](https://github.com/QNSC-VN/rally/commit/01a5920b2bc4072b3ed5e402b9890490924cd25d))
* **scm:** disconnecting an installation clears its repositories ([#171](https://github.com/QNSC-VN/rally/issues/171)) ([f96158b](https://github.com/QNSC-VN/rally/commit/f96158b13d5d442aac4bc7a0ab9dbe93325bcfac))
* **scm:** ensure public.scm_provider exists in migration 0061 ([#159](https://github.com/QNSC-VN/rally/issues/159)) ([7c258d9](https://github.com/QNSC-VN/rally/commit/7c258d961d0b98f8cf33e56986adc02c11a9cd77))
* **scm:** provide SECRET_RESOLVER in ScmModule so worker backfill can load the App key ([#167](https://github.com/QNSC-VN/rally/issues/167)) ([4fb9d2d](https://github.com/QNSC-VN/rally/commit/4fb9d2d3c0aff4df2ed15debba5eb5166e1875bb))
* **scm:** widen + truncate the Changesets Name column ([#176](https://github.com/QNSC-VN/rally/issues/176)) ([4c4606f](https://github.com/QNSC-VN/rally/commit/4c4606faa3569eafc088adce6f93dc1f538dd6f6))
* **seed:** assign team_id to seeded work items and tasks ([#119](https://github.com/QNSC-VN/rally/issues/119)) ([b8fca1d](https://github.com/QNSC-VN/rally/commit/b8fca1ddc04442006aa8b024e0c81f0d2eda27b8))
* SRS-align P1/P2 verify-pass residuals (BA DevInt audit) ([#152](https://github.com/QNSC-VN/rally/issues/152)) ([4ab4c29](https://github.com/QNSC-VN/rally/commit/4ab4c29039f5ca60b8c92db10e568d6a65c9c705))
* unblock uploads + gate prod tag deploys on infra apply ([#116](https://github.com/QNSC-VN/rally/issues/116)) ([92bae88](https://github.com/QNSC-VN/rally/commit/92bae88cf99d945b7262c3a8f243ae5f1d58f203))
* **web:** align nested task rows + add BA business-tracker retest suite ([#131](https://github.com/QNSC-VN/rally/issues/131)) ([9279905](https://github.com/QNSC-VN/rally/commit/92799054f90372dcd06f6ce0e73167ee5f845060))
* **web:** allow R2 in CSP connect-src so uploads can reach the bucket ([#118](https://github.com/QNSC-VN/rally/issues/118)) ([29f4292](https://github.com/QNSC-VN/rally/commit/29f42926c48186665b875b61c6c14191193549f6))
* **web:** centralize query invalidation with a tag-based registry ([#135](https://github.com/QNSC-VN/rally/issues/135)) ([cb3aeb5](https://github.com/QNSC-VN/rally/commit/cb3aeb5f0329ce22731fb61adc6231d73f967fef))
* **web:** rewrite RichTextEditor on Tiptap — document.execCommand is dead ([#122](https://github.com/QNSC-VN/rally/issues/122)) ([996c1fc](https://github.com/QNSC-VN/rally/commit/996c1fcd30e51cc9e63d08b6aaf746a135f5ab00))
* **web:** stop tailwind-merge from dropping button text color ([#120](https://github.com/QNSC-VN/rally/issues/120)) ([928ba11](https://github.com/QNSC-VN/rally/commit/928ba117a4d9ab65c6f8b543c403f67dfcdb3403))
* **web:** use 'white' keyword instead of raw hex in DetailHeaderButton ([#129](https://github.com/QNSC-VN/rally/issues/129)) ([58d1de4](https://github.com/QNSC-VN/rally/commit/58d1de4da617737fefd3a27dedb833d02198f26a))
* **work-items:** SRS-align P0 residuals — Team mandatory, default Idea, Task state labels ([#149](https://github.com/QNSC-VN/rally/issues/149)) ([8e408a0](https://github.com/QNSC-VN/rally/commit/8e408a0f36e2d11ab797ccdb04ecdc4868a30ae5))


### ♻️ Refactors

* **infra:** extract the product stack so develop and prod cannot drift ([#177](https://github.com/QNSC-VN/rally/issues/177)) ([8414254](https://github.com/QNSC-VN/rally/commit/841425459dbedb86f99cb8163af5165b62681652))
* **observability:** adopt @quynhonsemiconductor/observability and fix four logging defects ([#164](https://github.com/QNSC-VN/rally/issues/164)) ([6b02d4b](https://github.com/QNSC-VN/rally/commit/6b02d4bcf7ef25f3c62db77a61389f9d2c8697d9))


### 📦 Dependencies

* clear osv-scanner CVE gate (fastify-static, swagger, postcss, js-yaml) ([#147](https://github.com/QNSC-VN/rally/issues/147)) ([c966c8e](https://github.com/QNSC-VN/rally/commit/c966c8ef2ef7bc6d6c6260037c531bdcd423fa91))

## [0.2.3](https://github.com/QNSC-VN/rally/compare/v0.2.2...v0.2.3) (2026-07-20)


### ✨ Features

* per-workspace RBAC, granular permissions, project & track UX ([#102](https://github.com/QNSC-VN/rally/issues/102)) ([3c367a6](https://github.com/QNSC-VN/rally/commit/3c367a6f5c780e5d72d8db309235c8f40cb1132e))
* phase 4 BA-design alignment (audit, roles, workflow, notifications, user phone) ([#100](https://github.com/QNSC-VN/rally/issues/100)) ([c3da490](https://github.com/QNSC-VN/rally/commit/c3da490dd38e61f64f6f4860f2cead1c38f01485))
* **rally:** align BA domains (F1-F7) + dev elasticache cache fix ([#97](https://github.com/QNSC-VN/rally/issues/97)) ([e118e24](https://github.com/QNSC-VN/rally/commit/e118e24f2108a414708d9406913e4f059722f9f2))
* **rally:** readable audit log + work-item/iteration/member follow-ups ([#106](https://github.com/QNSC-VN/rally/issues/106)) ([e47b8bf](https://github.com/QNSC-VN/rally/commit/e47b8bf87b14784cef3028dd42014ef47f9b0844))
* **web:** align projects table + modals with BA design ([#105](https://github.com/QNSC-VN/rally/issues/105)) ([36de097](https://github.com/QNSC-VN/rally/commit/36de097c7a387f1edd9efda634859ef04f4d9ead))
* **web:** paginate Projects list with shared PaginationFooter ([#104](https://github.com/QNSC-VN/rally/issues/104)) ([3417fe2](https://github.com/QNSC-VN/rally/commit/3417fe215dbdb3fc52b4ad9206e7793e9e624725))
* **web:** searchable Projects & Teams accordion in workspace switcher ([#103](https://github.com/QNSC-VN/rally/issues/103)) ([2614638](https://github.com/QNSC-VN/rally/commit/2614638d77e15a3fb9409560551b5212c4a22d9c))


### 🐛 Bug Fixes

* close BA-alignment gaps + tier-split and correct the seed system ([#107](https://github.com/QNSC-VN/rally/issues/107)) ([d6e90dc](https://github.com/QNSC-VN/rally/commit/d6e90dccac0bf10a2c55bd91a1e6b6ab5119ea52))
* **infra:** stop seeding demo fixtures into prod ([#108](https://github.com/QNSC-VN/rally/issues/108)) ([b62025e](https://github.com/QNSC-VN/rally/commit/b62025e4bed86f29d7409984affb9ef01f46b713))
* **rally:** align BA domains — item_key format, stepper, fractional story points ([#99](https://github.com/QNSC-VN/rally/issues/99)) ([15ce95c](https://github.com/QNSC-VN/rally/commit/15ce95c348e24bb51dc8fe28ac174afa0649d909))

## [0.2.2](https://github.com/QNSC-VN/rally/compare/v0.2.1...v0.2.2) (2026-07-16)


### 🐛 Bug Fixes

* **infra:** grant ecr:DescribeImages to rally ecr-push role ([#91](https://github.com/QNSC-VN/rally/issues/91)) ([cbf64f3](https://github.com/QNSC-VN/rally/commit/cbf64f3f689b8fa95408aad1792478f6e603b081))
* **infra:** surface prod infra-ID publish failures loudly instead of silent green ([#93](https://github.com/QNSC-VN/rally/issues/93)) ([f7d93ff](https://github.com/QNSC-VN/rally/commit/f7d93ff0715a6cd0b153c56ccf8f5f7f754aa068))

## [0.2.1](https://github.com/QNSC-VN/rally/compare/v0.2.0...v0.2.1) (2026-07-16)


### ✨ Features

* **infra:** consume R2 attachment storage via remote state (dev+prod) ([#87](https://github.com/QNSC-VN/rally/issues/87)) ([d69aa2f](https://github.com/QNSC-VN/rally/commit/d69aa2fdf81b57187ae7b8ea3bb8c5c46acbbbbf))
* **platform:** make StorageService endpoint-aware for S3-compatible backends ([#86](https://github.com/QNSC-VN/rally/issues/86)) ([4768485](https://github.com/QNSC-VN/rally/commit/47684854a9c8585282ebf788da3843bc2b853ac3))
* **tracking:** add TA-prefixed task keys and shared work-item grid UI ([#81](https://github.com/QNSC-VN/rally/issues/81)) ([3ac95d6](https://github.com/QNSC-VN/rally/commit/3ac95d6b53c50ce1753ccb6c122ac784bd2de55d))
* **web:** work-item grid suite with shared table engine and track-page enhancements ([#85](https://github.com/QNSC-VN/rally/issues/85)) ([485a88e](https://github.com/QNSC-VN/rally/commit/485a88e484a74cb41fd3165273df8bcc4da090bb))


### 🐛 Bug Fixes

* **ci:** serialize deploys by environment to prevent concurrent prod migrations ([#75](https://github.com/QNSC-VN/rally/issues/75)) ([f3227e6](https://github.com/QNSC-VN/rally/commit/f3227e62e8ec23e320c9aabbb070cd316095bb68))


### ♻️ Refactors

* **identity:** adopt shared @quynhonsemiconductor/identity BFF mechanism ([#73](https://github.com/QNSC-VN/rally/issues/73)) ([cea7756](https://github.com/QNSC-VN/rally/commit/cea7756d58be126a83e8aabfb6bf07139eec5bf2))

## [0.2.0](https://github.com/QNSC-VN/rally/compare/v0.1.0...v0.2.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* same-origin BFF auth (Entra confidential client), remove legacy MSAL ([#43](https://github.com/QNSC-VN/rally/issues/43))

### ✨ Features

* **access:** single-source frontend permission gating + backend drift guard ([#71](https://github.com/QNSC-VN/rally/issues/71)) ([f3932c5](https://github.com/QNSC-VN/rally/commit/f3932c5b63b744ad2dd647b40ebfaddf7174cf69))
* add pgEnums for attachment status, activity entity type, sso provider ([6e8ce63](https://github.com/QNSC-VN/rally/commit/6e8ce63459bda041d0e9c7fe9eb72ca99932a35e))
* **ci:** add CODEOWNERS, PR labeler, and release commenter bot ([5bc4c6a](https://github.com/QNSC-VN/rally/commit/5bc4c6af01ed6e36b46b220eced5cd2eabb61e59))
* **deployment:** DEPLOYMENT_MODE switch for single-tenant vs SaaS ([fd04da1](https://github.com/QNSC-VN/rally/commit/fd04da16a4d44f0fb3b4a98c5c709ce36cbce855))
* harden infra — tag-gate prod, Terraform-managed DNS, clean teardowns ([10213e2](https://github.com/QNSC-VN/rally/commit/10213e239266689a865574c62141bea8852de712))
* implement BA review Phase 1 gaps ([2768ac1](https://github.com/QNSC-VN/rally/commit/2768ac1aab5e0c1009117ce01531c65a73d35fe8))
* implement phase 2 - backlog and integration ([fdc1de7](https://github.com/QNSC-VN/rally/commit/fdc1de7f871b9f5a694ecd0725e7b525188c2be9))
* **infra:** bring rally prod stack to parity with develop ([#56](https://github.com/QNSC-VN/rally/issues/56)) ([e50d250](https://github.com/QNSC-VN/rally/commit/e50d2501868f0c718c1840dae9dba0289f1632ca))
* **infra:** dev API on Cloudflare-proxied subdomain; lock ALB to CF IPs ([b3958f2](https://github.com/QNSC-VN/rally/commit/b3958f2f50f87b8c35665926d1796d3b5bef44b0))
* **infra:** migrate develop to shared runtime (Option A) ([#22](https://github.com/QNSC-VN/rally/issues/22)) ([30187f2](https://github.com/QNSC-VN/rally/commit/30187f2e91a5a32d335763a40d8309c9ad24d3e2))
* **iterations:** add assignment-options endpoint and wire teamId in frontend pickers ([cdc0053](https://github.com/QNSC-VN/rally/commit/cdc005316948f65c81356d3af019ddfd42f332f4))
* phase 2 - backlog (P2.1), timeboxes (P2.2) and iteration status (P2.3) ([703e9a4](https://github.com/QNSC-VN/rally/commit/703e9a46693fd3f5a8a0a21440de3f6b73a2e6f7))
* phase 3 — milestones, quality/defects, releases, team status, and settings pages ([#50](https://github.com/QNSC-VN/rally/issues/50)) ([d00ea23](https://github.com/QNSC-VN/rally/commit/d00ea232a17fc798580e10bd4ecb0c572b33732d))
* rally monorepo — consolidate rally-api + rally-web + rally-infra ([85da7c2](https://github.com/QNSC-VN/rally/commit/85da7c2385c38e26866b1f4217fc0e73799bf7c0))
* **rbac:** shared permission catalogue + scope-aware per-project authorization ([cb79347](https://github.com/QNSC-VN/rally/commit/cb793478b45c007eb92c50eb67e4924cde7c1fac))
* same-origin BFF auth (Entra confidential client), remove legacy MSAL ([#43](https://github.com/QNSC-VN/rally/issues/43)) ([555aa22](https://github.com/QNSC-VN/rally/commit/555aa22a6d76cf1fbfe4cffd86ec09b66a8fb618))
* **seed:** add phase 0/1/2 test data and fix project members displayName ([bed1f9b](https://github.com/QNSC-VN/rally/commit/bed1f9b6effb0b4ca473cce7c42bcb0740b86581))
* **seed:** add Phase 2 data — teams, iterations, releases, extended work items ([8f144bf](https://github.com/QNSC-VN/rally/commit/8f144bf58b726d7e465866af64f96cae3daf4161))
* **seed:** RBAC/PBAC demo coverage + restrict SSO to qnsc.vn ([1988d3b](https://github.com/QNSC-VN/rally/commit/1988d3b3c8eae2751f50e2f51f873fe5596afe99))
* **ui:** enterprise DRY primitives - Spinner, Skeleton, NativeSelect, SaveIndicator, useSaveState; router prefetch ([d300030](https://github.com/QNSC-VN/rally/commit/d30003063a980748c0f0602c9a520b19f6b59d45))
* **ui:** enterprise UX improvements - toast feedback, Tooltip component, error handling ([5c41ad7](https://github.com/QNSC-VN/rally/commit/5c41ad7b25a28259b12c52eb67ed1a7d484c5dd4))
* **web:** add shared UI component layer for enterprise consistency ([4cdbdf2](https://github.com/QNSC-VN/rally/commit/4cdbdf2af3f5ed936833525848e2d4af5dcf859d))
* **web:** migrate rally SPA to Cloudflare Pages (drop CloudFront) ([#19](https://github.com/QNSC-VN/rally/issues/19)) ([1229f78](https://github.com/QNSC-VN/rally/commit/1229f78438fd56cc3ffded3b952b2f73360d7f3f))
* **web:** team context selection and create-flow auto-fill ([eefa77a](https://github.com/QNSC-VN/rally/commit/eefa77a8776ccf5d59240462844d748e7d0d8308))


### 🐛 Bug Fixes

* add double-submit CSRF protection to refresh token endpoint ([969e5f4](https://github.com/QNSC-VN/rally/commit/969e5f44f3dfd632e609788539fc3d34ee56b6ce))
* **api:** dedupe fastify to 5.10.0 to repair backend build ([#35](https://github.com/QNSC-VN/rally/issues/35)) ([e3c7a44](https://github.com/QNSC-VN/rally/commit/e3c7a4498a6d6ee436805ba7325258fb6707cf7b))
* **api:** remove unnecessary type assertion in project-member repository ([8e7dbc7](https://github.com/QNSC-VN/rally/commit/8e7dbc79530daf6b6654284efca3ce5fbd1b3768))
* **api:** serve health probes under /v1 prefix ([be697dd](https://github.com/QNSC-VN/rally/commit/be697dd76a1549b6249afc84a7db13ae7f9e19e1))
* **auth:** self-heal SSO login, split seed by env, add refresh rotation grace ([#40](https://github.com/QNSC-VN/rally/issues/40)) ([1ebfeab](https://github.com/QNSC-VN/rally/commit/1ebfeab95afaf03dd9f23cef3352b3aadce9a105))
* **backlog:** use human-readable labels for Schedule State inline dropdown ([c77c645](https://github.com/QNSC-VN/rally/commit/c77c64513ac66ec651e5649d17059d6d8fe2de95))
* **build:** repair root typecheck scope, spec type errors, and web test setup ([48c48e7](https://github.com/QNSC-VN/rally/commit/48c48e7cdbfd55dc46ffd7c9210f8b45c2edb1a9))
* **build:** resolve TS errors and polish FE interactions ([2649077](https://github.com/QNSC-VN/rally/commit/26490777b131dcb71229d700366ad7cc30115590))
* bump stale module version pins in prod to match develop ([fcfdb76](https://github.com/QNSC-VN/rally/commit/fcfdb769d6f5e09dee578a09ec4d4369d0a16d48))
* **ci:** add pull_request edited trigger so title changes re-run checks ([b33c5ef](https://github.com/QNSC-VN/rally/commit/b33c5ef1302d16e3d5d7cabb2196c05ef671e544))
* **ci:** add pull-requests:read permission for PR title check ([8770f4c](https://github.com/QNSC-VN/rally/commit/8770f4c7d66a43aa28032a293bacfff82c8dd501))
* **ci:** add Trivy CVE scan before attest; fix ECS wait timeout ([46b332b](https://github.com/QNSC-VN/rally/commit/46b332bd06b4c89bb74169a9d2f812c3b756d16d))
* **ci:** configure git credentials for private module cloning in tofu init ([d8bf6ac](https://github.com/QNSC-VN/rally/commit/d8bf6aca8fab0baf58487bc3cd72b64dc406140b))
* **ci:** correct infra workflow paths from live/ to infra/live/ ([5657c97](https://github.com/QNSC-VN/rally/commit/5657c970135e5efb3daf2ebf21abc7e2fede6f84))
* **ci:** fix 4 failing CI checks on main ([12acc06](https://github.com/QNSC-VN/rally/commit/12acc06d79407dcae346ca262ae86b93245e0bf2))
* **ci:** fix YAML error in release-commenter, fix role ARN→name in RDS policy ([dde2932](https://github.com/QNSC-VN/rally/commit/dde2932c83431260496af68db983bdc156fdeec4))
* **ci:** gitleaks toml syntax + exclude apps/web from backend tsc ([c564390](https://github.com/QNSC-VN/rally/commit/c56439023c026df3d3fa521cf60f32894f8f2785))
* **ci:** grant id-token permission to infra-plan caller ([#52](https://github.com/QNSC-VN/rally/issues/52)) ([9448809](https://github.com/QNSC-VN/rally/commit/94488091fa6f2f1c42acd782690583efa0210b75))
* **ci:** grant packages:read to the security caller ([#45](https://github.com/QNSC-VN/rally/issues/45)) ([a45d501](https://github.com/QNSC-VN/rally/commit/a45d501d8adad74c9961b98b4772c8b26eddc09b))
* **ci:** ignore Go stdlib CVEs in esbuild dev-tool binary ([42a4cfa](https://github.com/QNSC-VN/rally/commit/42a4cfa65e1d54cd717bc4bc370e19f240b51b1c))
* **ci:** make dependency review non-blocking on private repos without GHAS ([ae29ca4](https://github.com/QNSC-VN/rally/commit/ae29ca4f54192a07a915817bbf55d6dd7ca0a3e1))
* **ci:** read CLOUDFLARE_ACCOUNT_ID as a variable, not a secret ([#53](https://github.com/QNSC-VN/rally/issues/53)) ([128df00](https://github.com/QNSC-VN/rally/commit/128df0068675316cfe97b62e87fd3901ccb9b52c))
* **ci:** release.yml — use continue-on-error for app-token fallback ([feaf9b6](https://github.com/QNSC-VN/rally/commit/feaf9b6336de40d6d2dcba30c4d113db3ad18f28))
* **ci:** remove unused imports, fix eslint warnings in app-shell ([fbed799](https://github.com/QNSC-VN/rally/commit/fbed799b311deb73238baa07eff0cda579548a42))
* **ci:** scope concurrency groups — ci-backend / ci-web ([391a447](https://github.com/QNSC-VN/rally/commit/391a4475d0b58129a9d25d84bf8120e708eb20de))
* **ci:** simplify tofu git config now qnsc-tf-modules is public (no app token needed) ([347ade7](https://github.com/QNSC-VN/rally/commit/347ade71e4e9819c1012f9847db02395939e6d4d))
* **ci:** skip dependency review (requires GHAS paid license) ([bb345ff](https://github.com/QNSC-VN/rally/commit/bb345ffd9b69d762f8f2b37fb48deffacf26ca6c))
* **ci:** SLSA attestation requires paid plan — add continue-on-error ([ddeb436](https://github.com/QNSC-VN/rally/commit/ddeb436f7d2df71fc6a6051432a9ddfe5ae8c150))
* **ci:** trivy-action 0.37.0 → 0.36.0 (latest) ([b3d1d06](https://github.com/QNSC-VN/rally/commit/b3d1d06abe4bb86b32a7349189d9879b01c645a6))
* **ci:** trivy-action tag needs v prefix (v0.36.0) ([30fde34](https://github.com/QNSC-VN/rally/commit/30fde34d3895cc69b6b422fbf0c603328259765e))
* **ci:** use GitHub App token for cross-repo private module access in tofu init ([0b9150d](https://github.com/QNSC-VN/rally/commit/0b9150d5c2f2702b3fc5d793b59649f0dc63bd39))
* **ci:** use qnsc-ci@v1.3 with fixed action SHAs for infra apply ([2a9517c](https://github.com/QNSC-VN/rally/commit/2a9517ca4049526ef668d4fad09cd6e82a68472a))
* **ci:** use qnsc-ci@v1.4 (fresh tag with fixed action SHAs) ([eed4aa5](https://github.com/QNSC-VN/rally/commit/eed4aa59de8206fe90ce15eaf004a9a6a5b47855))
* **ci:** use qnsc-ci@v1.5 (correct SHA for fixed action) ([d590105](https://github.com/QNSC-VN/rally/commit/d59010591204e2409620fff98f3e87914b1e4247))
* **ci:** use setup-tofu-aws@v1.2 composite action in infra workflows ([e0ec2bc](https://github.com/QNSC-VN/rally/commit/e0ec2bc54302c2d87568cc4c805619815e077dc8))
* **ci:** use vars instead of secrets for non-sensitive ACM/Entra config ([7f4b810](https://github.com/QNSC-VN/rally/commit/7f4b8106d1a899525d08910280574d695a20064a))
* **ci:** web deploy uses apps/web/dist; e2e passes with no tests ([b0e8827](https://github.com/QNSC-VN/rally/commit/b0e882708b9ddf95597574dfdc9e85b50ecdfbc3))
* correct CSRF cookie name mismatch and stabilize Ctrl+Enter shortcut ([020768b](https://github.com/QNSC-VN/rally/commit/020768b989a4af7e5981b9abaf708b0dc24a63e0))
* correct stale filenames in infra CI path filters, add manual dispatch ([d7e8c1a](https://github.com/QNSC-VN/rally/commit/d7e8c1a11dfd4d7772d791908c9ef9aae3147cbd))
* **db:** allow develop migrator to seed despite NODE_ENV=production ([#37](https://github.com/QNSC-VN/rally/issues/37)) ([b8dafcc](https://github.com/QNSC-VN/rally/commit/b8dafcc8201145cd141e7ac566df71c2bb35e03e))
* **db:** backfill member_capacity skipped by duplicate migration timestamp ([#65](https://github.com/QNSC-VN/rally/issues/65)) ([b60ab24](https://github.com/QNSC-VN/rally/commit/b60ab2421d78713767f367106e648abded27917f))
* **db:** drop/recreate attachments partial index across enum type change ([2e810f1](https://github.com/QNSC-VN/rally/commit/2e810f1283f31752c5f840f61dc90effa781cf12))
* **db:** widen project_counters PK before per-type seed in 0036 ([#60](https://github.com/QNSC-VN/rally/issues/60)) ([e398b3b](https://github.com/QNSC-VN/rally/commit/e398b3b313b7fb035a92f07b5d8a1baba16a7d5b))
* **deploy:** grant ecs:ListTasks + wake ECS in dev deploy guard ([adf56e5](https://github.com/QNSC-VN/rally/commit/adf56e5057ce41c83b03947fb673ac72e531298d))
* **deploy:** wait for RDS availability before migration (dev cost-saver guard) ([2d758cc](https://github.com/QNSC-VN/rally/commit/2d758cceb34fe3473f40d59df4bf824ce193231e))
* disable RDS CA verify for VPC-internal connections ([d8aa7f6](https://github.com/QNSC-VN/rally/commit/d8aa7f6b2921d096113ee3033d21f54bf7a67880))
* **docker:** bump Alpine 3.21 → 3.22 to fix CVE-2025-68121 ([3c1d497](https://github.com/QNSC-VN/rally/commit/3c1d497fe2d0cc4131c9994db4af38a177dd9e52))
* elevateToWorkspaceAdmin preserves project-scoped roles ([903d45d](https://github.com/QNSC-VN/rally/commit/903d45db909cc5a979143def2ad1d714ba65076e))
* enforce tenant isolation in repository findById/update/softDelete ([a37beec](https://github.com/QNSC-VN/rally/commit/a37beec4cfb8b4ed1953fa4a822b4275cd9a1c65))
* extract pgOptions helper, apply SSL fix to seed.ts ([0861638](https://github.com/QNSC-VN/rally/commit/0861638aaf15d71ae7e70730050c1d72cd0938a6))
* harden auth and access — wildcard perms, rate limit, constants, DRY ([a136fe9](https://github.com/QNSC-VN/rally/commit/a136fe9c2156a522412b5313eb203bec93e40fe4))
* **infra/develop:** fix 502 on /v1/* — ALB http-only + forward rule ([291bbdb](https://github.com/QNSC-VN/rally/commit/291bbdbab0b97aa9217c14b46e5343a185184614))
* **infra/develop:** pass ENTRA_TENANT_ID to migrator task for SSO seed ([25988f6](https://github.com/QNSC-VN/rally/commit/25988f626fb60a1dcb1f7283cf176d765ade97c6))
* **infra:** add rds:DescribeDBInstances+StartDBInstance to develop deploy role ([c50e932](https://github.com/QNSC-VN/rally/commit/c50e932e54f27614dbfe97934261ecd83b218235))
* **infra:** bump dns-record to v1.1.0 to adopt orphaned CNAME ([#24](https://github.com/QNSC-VN/rally/issues/24)) ([f9b73c5](https://github.com/QNSC-VN/rally/commit/f9b73c5eac7c808ce61914b7ac2f66c2d49a4885))
* **infra:** set Pages Function API_ORIGIN for same-origin BFF proxy ([#47](https://github.com/QNSC-VN/rally/issues/47)) ([e404a5b](https://github.com/QNSC-VN/rally/commit/e404a5b303b94ef33f2aa28e97e1bb1a8ac96ccf))
* **infra:** update monorepo refs (rally-api→rally, rally-infra→rally) in OIDC module ([698b9e2](https://github.com/QNSC-VN/rally/commit/698b9e2c855db82797dab043bb33d936d8aae3ff))
* **infra:** use iam-oidc-v1.1.0 with StringLike wildcard for environment OIDC support ([1d82541](https://github.com/QNSC-VN/rally/commit/1d82541842a0308231c1f6ab0d0a582c8c931bf0))
* **jwt:** align test keys to ES256 (EC P-256) ([df0443f](https://github.com/QNSC-VN/rally/commit/df0443fd380c4057fc2c95f042e70b62c5aed07b))
* **jwt:** correct .env.example keygen comment from EdDSA to EC P-256 ([6b33f79](https://github.com/QNSC-VN/rally/commit/6b33f79fc4907661aae9929c905a543152b5749a))
* migration enum cast and stale type assertions in attachment repo ([c8886d2](https://github.com/QNSC-VN/rally/commit/c8886d22f44a61cbb7a9ed16947f7ee1c96e215f))
* **phase2:** UI verification fixes for P2.2 and P2.3 ([4f56948](https://github.com/QNSC-VN/rally/commit/4f5694822c477d0d6911a748a4297f1c71ca0258))
* RDS dev-guard policy no longer needs the instance to already exist ([17ef18e](https://github.com/QNSC-VN/rally/commit/17ef18ebb7ceebf9499e801c99f8c7355b237314))
* **release:** emit vX.Y.Z tags so Release PR triggers deploy ([#66](https://github.com/QNSC-VN/rally/issues/66)) ([ee75781](https://github.com/QNSC-VN/rally/commit/ee75781d9b2bda11a8c2f4c22a5b898e126a5704))
* rename prod web bucket, rally-web-prod is claimed by another AWS account ([0fc293a](https://github.com/QNSC-VN/rally/commit/0fc293ac8a82801b402cf97d83eba4e68d7bc92b))
* resolve broken home metric links, add error states, work item delete ([cfaf52f](https://github.com/QNSC-VN/rally/commit/cfaf52fd117aca24e7dd3de922149c95edb55472))
* **seed:** link seeded teams to their projects (project_teams) ([bf797ec](https://github.com/QNSC-VN/rally/commit/bf797ec360989c86d9b442147e9fbd920b344cf7))
* **seed:** prevent counter regression with GREATEST, add release:manage to admin roles ([c6ae09e](https://github.com/QNSC-VN/rally/commit/c6ae09e1c02e6a86a7fa9e4f6a2d04228bdbcdc9))
* **spec:** restore missing imports and update stale fixtures ([93564f9](https://github.com/QNSC-VN/rally/commit/93564f9badb17cfa49ef40c0b291bf6af9bc5abd))
* stale projectId in release mutations and form sync during render ([9511e8f](https://github.com/QNSC-VN/rally/commit/9511e8f3f070918cc5876b806bd189f72f3e253a))
* strip sslmode from URL before passing ssl config to pg ([215547f](https://github.com/QNSC-VN/rally/commit/215547ffcf8837ce0cdb1c62d8695a969a4c8366))
* **test:** LOG_LEVEL 'silent' not valid — use 'error' ([805374f](https://github.com/QNSC-VN/rally/commit/805374f1ae888a38a253d16d7e37d2cb4faacaf9))
* **tests:** fix 2 failing unit tests ([4030096](https://github.com/QNSC-VN/rally/commit/403009658dc49a5ac203fad023171f7c6fa70427))
* TypeScript type errors and PLATFORM_ADMIN_EMAILS elevation ([ba5847a](https://github.com/QNSC-VN/rally/commit/ba5847a58f3a22e77a0eada68fb12c6e1d147cce))
* **ui:** add cursor-pointer and hover states to all interactive buttons ([c853d5c](https://github.com/QNSC-VN/rally/commit/c853d5c1733276416b9fe5d9b017cf6463144acb))
* **ui:** add focus ring to RichTextEditor matching Input/Textarea style ([5645aea](https://github.com/QNSC-VN/rally/commit/5645aea59b7f494f4475be12af43e756d14cb89b))
* **ui:** correct mismatched InlineSelect/NativeSelect JSX tags ([9c59f56](https://github.com/QNSC-VN/rally/commit/9c59f562a014168362d27d2b87e44c667e836647))
* unify PLATFORM_ADMIN_EMAILS elevation and add missing permission guards ([4a60e83](https://github.com/QNSC-VN/rally/commit/4a60e837367c8e8cc3fbe0875b61344a4e6c5832))
* web-deploy IAM trust policy referenced archived rally-web repo ([ea055fe](https://github.com/QNSC-VN/rally/commit/ea055fe35e1bc4a6832e46651c2fa5c57aa27df4))
* **web-deploy:** deploy Pages Functions from apps/web working dir ([#54](https://github.com/QNSC-VN/rally/issues/54)) ([ce6ad8d](https://github.com/QNSC-VN/rally/commit/ce6ad8db8e3fd9786c4c5063ff02f952b8f21939))
* **web:** consistent cursor-pointer + fix grid ID column overflow ([#62](https://github.com/QNSC-VN/rally/issues/62)) ([1a2ab78](https://github.com/QNSC-VN/rally/commit/1a2ab787be0bc8347c9a9a8591519ef0c888ab4f))
* **web:** fix backlog table overflow and inline-select text truncation ([f0af649](https://github.com/QNSC-VN/rally/commit/f0af649f7bde3277e587540178a2d13c4daefe6d))
* **web:** fix network error — CloudFront proxies /v1/* to ALB ([ddad4e4](https://github.com/QNSC-VN/rally/commit/ddad4e489e885e8c65b68b1f2d0688ab0cdde78b))
* **web:** resolve pre-existing eslint errors ([e2ea849](https://github.com/QNSC-VN/rally/commit/e2ea8490b94c2697a03ae73f22e5e4a1cf4f3e8c))
* **web:** sign-out redirects to /login for password sessions, not Microsoft ([fbaea05](https://github.com/QNSC-VN/rally/commit/fbaea055605eab9e39f53da6801b3f44c062fba8))
* **web:** unwrap members array response correctly in useProjectMembers ([8460ae0](https://github.com/QNSC-VN/rally/commit/8460ae0e50b6245c0c0310d303cd077f1102c93e))
* **work-items:** enforce project-tier work_item:view on read endpoints ([#69](https://github.com/QNSC-VN/rally/issues/69)) ([de82fc3](https://github.com/QNSC-VN/rally/commit/de82fc3899bf45c3aaee73ff0cf750f2d89777ad))


### ♻️ Refactors

* **access:** project-scoped writes + monotonic roles; migration upgrade-path CI gate ([4a3e548](https://github.com/QNSC-VN/rally/commit/4a3e548feba63cf49b70f8cec011767e39109cc3))
* adopt shared alb, dns-record, oneshot-task modules; export cloudflare facts from bootstrap ([c14e1f3](https://github.com/QNSC-VN/rally/commit/c14e1f3010481a51895a33551d398169b62c2298))
* **auth:** delegate workspace-tier guard to @quynhonsemiconductor/identity ([#70](https://github.com/QNSC-VN/rally/issues/70)) ([c4bd59b](https://github.com/QNSC-VN/rally/commit/c4bd59be798b2f67a98e23ed44ae468b1cd62049))
* **auth:** remove legacy ENTRA_DEFAULT_TENANT_ID SSO fallback ([4232fa5](https://github.com/QNSC-VN/rally/commit/4232fa5b047f1176c5dc28c4bc699ec57f8208cf))
* **auth:** remove password login, SSO-only (mirror opshub) ([#38](https://github.com/QNSC-VN/rally/issues/38)) ([90c0cc0](https://github.com/QNSC-VN/rally/commit/90c0cc08b5150690d52ce3b4a7a0a8ae3c1b3ea2))
* drop multi-tenancy, merge tenant into workspace ([#33](https://github.com/QNSC-VN/rally/issues/33)) ([71f9cc5](https://github.com/QNSC-VN/rally/commit/71f9cc5940828a4ea58cd3551415ac9bcc45c67d))
* **infra:** drop vestigial acm_cert_arn plumbing ([#51](https://github.com/QNSC-VN/rally/issues/51)) ([2887ba1](https://github.com/QNSC-VN/rally/commit/2887ba108d51ca102787ba8e3c010f783fdd5adf))
* **infra:** make develop deployment_mode a variable, symmetric with prod ([7004f42](https://github.com/QNSC-VN/rally/commit/7004f4281f85aeba6769b3a3c09496b88d77c2f9))
* NativeSelect/InlineSelect migration, query key factories, Zustand devtools ([a9a8ecc](https://github.com/QNSC-VN/rally/commit/a9a8ecc27208ec185df5ab8a328b62232f268bd6))
* **prod:** drop lean/ha tier, single clean prod config ([#58](https://github.com/QNSC-VN/rally/issues/58)) ([f70322a](https://github.com/QNSC-VN/rally/commit/f70322ac8ebcd0ce53d9f3693ea15d2ad3241844))
* remove dead code + dedupe the wildcard-permission check ([6775fea](https://github.com/QNSC-VN/rally/commit/6775feab044092bb6ad8655ee0803135f479779e))
* **web:** extract shared OwnerCell component ([#64](https://github.com/QNSC-VN/rally/issues/64)) ([1c013ac](https://github.com/QNSC-VN/rally/commit/1c013ac9c607d6a3de083a248ce66f70f098f8a4))


### 🔒 Security

* untrack terraform.tfvars (move to .gitignore) ([a086e91](https://github.com/QNSC-VN/rally/commit/a086e91b50286a235025faf512e04ec0679f7a02))


### 📦 Dependencies

* bump the development-dependencies group across 1 directory with 14 updates ([21c68eb](https://github.com/QNSC-VN/rally/commit/21c68eb7434ed4b51eb0edefa7a6afa6b977b52b))
* bump the development-dependencies group with 3 updates ([#17](https://github.com/QNSC-VN/rally/issues/17)) ([5949737](https://github.com/QNSC-VN/rally/commit/59497370af46d35bb98de0384102f49d140ac1a3))
* bump the production-dependencies group across 1 directory with 21 updates ([#11](https://github.com/QNSC-VN/rally/issues/11)) ([5d53641](https://github.com/QNSC-VN/rally/commit/5d53641d6d2df1086a32862826fae48a5f45fb8c))
