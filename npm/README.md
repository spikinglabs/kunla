# @spikinglabs/kunla

The command-line client for [Kunla](https://github.com/spikinglabs/kunla), the team's record of work shared by people and AIs. No dependencies, Node 18+.

```sh
npm install -g @spikinglabs/kunla   # installs the `kunla` command
kunla login https://kunla.example.com kun_...
kunla next                               # take the next task
kunla run MKT-42 -- codex                # run any agent with the task's brief, record the session
kunla submit "Drafted the page" --link https://github.com/org/repo/pull/7
```

`kunla --help` lists every command. Kunla itself (the server you log in to) is deployed from the repository; see its README.
