FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /out/agent .

FROM alpine:3.20
COPY --from=build /out/agent /usr/local/bin/agent
ENTRYPOINT ["agent"]
