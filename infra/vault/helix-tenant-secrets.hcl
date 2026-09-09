# Runtime may read only one opaque secret below a server-owned tenant scope.
# `+` is Vault's single-path-segment wildcard, so handles cannot escape or list tenants.
path "secret/data/tenants/+/byo-storage/+" {
  capabilities = ["read"]
}

path "secret/data/tenants/+/idp/+" {
  capabilities = ["read"]
}

path "secret/data/tenants/+/byo-identity/+" {
  capabilities = ["read"]
}

path "secret/data/tenants/+/mail-provider/+" {
  capabilities = ["read"]
}
