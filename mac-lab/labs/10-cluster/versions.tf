terraform {
  required_version = ">= 1.6"

  required_providers {
    # Community provider. 0.11.0 published 2026-02-05.
    # If `terraform init` complains, check the registry for a newer minor:
    #   https://registry.terraform.io/providers/tehcyx/kind/latest
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.11"
    }
  }
}
