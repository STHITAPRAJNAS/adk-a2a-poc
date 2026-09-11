terraform {
  required_version = ">= 1.6"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
  }
}

# Configured from a kubeconfig on disk, not from another module's outputs — see
# the note in labs/10-cluster/main.tf about why that separation is forced.
provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}
