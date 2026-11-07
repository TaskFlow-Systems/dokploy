// The replica's form imports this too, so it stays free of server-only modules.

export const LIBSQL_GRPC_TLS_DIR = "/tmp/dokploy-grpc";
const files = {
	ca: `${LIBSQL_GRPC_TLS_DIR}/ca.pem`,
	cert: `${LIBSQL_GRPC_TLS_DIR}/cert.pem`,
	key: `${LIBSQL_GRPC_TLS_DIR}/key.pem`,
};

export const LIBSQL_GRPC_PRIMARY_FLAGS = `--grpc-tls --grpc-cert-file ${files.cert} --grpc-key-file ${files.key} --grpc-ca-cert-file ${files.ca}`;
export const LIBSQL_GRPC_REPLICA_FLAGS = `--primary-grpc-tls --primary-grpc-cert-file ${files.cert} --primary-grpc-key-file ${files.key} --primary-grpc-ca-cert-file ${files.ca}`;

// sqld takes these only as flags, so the files come from Env on every start,
// before any command, a custom one included.
export const LIBSQL_GRPC_TLS_SETUP = `umask 077 && mkdir -p ${LIBSQL_GRPC_TLS_DIR} &&
printf '%s' "$DOKPLOY_GRPC_CA" | base64 -d > ${files.ca} &&
printf '%s' "$DOKPLOY_GRPC_CERT" | base64 -d > ${files.cert} &&
printf '%s' "$DOKPLOY_GRPC_KEY" | base64 -d > ${files.key} || exit 1`;

// A primary of this panel takes only TLS from a node with its certificate, so an
// http:// URL the panel showed before is dialed over https.
export const toLibsqlGrpcTlsUrl = (url: string) =>
	url.replace(/^http:\/\//i, "https://");
