---
name: docker
description: "Docker container management: build, run, compose, inspect containers and images."
metadata:
  cereworker:
    emoji: "\U0001F433"
    requires:
      bins: ["docker"]
---

# Docker Skill

Use `docker` and `docker compose` for container management.

## Common Commands

### Containers
```bash
docker ps
docker ps -a
docker logs <container>
docker exec -it <container> bash
docker stop <container>
docker rm <container>
```

### Images
```bash
docker images
docker build -t <name> .
docker pull <image>
docker rmi <image>
```

### Compose
```bash
docker compose up -d
docker compose down
docker compose logs -f
docker compose ps
```
