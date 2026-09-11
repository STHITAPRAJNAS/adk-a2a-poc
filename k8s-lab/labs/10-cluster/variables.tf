variable "cluster_name" {
  description = "kind cluster name. Node container names derive from it: <name>-control-plane, <name>-worker, <name>-worker2, …"
  type        = string
  default     = "a2a-lab"
}

variable "node_image" {
  description = "kind node image, which pins the Kubernetes version. Keep in sync with ../../versions.env."
  type        = string
  default     = "kindest/node:v1.36.1"
}

variable "cpu_worker_count" {
  description = "Workers that will be labelled as the general-purpose pool."
  type        = number
  default     = 2

  validation {
    condition     = var.cpu_worker_count >= 1
    error_message = "You need at least one CPU worker; the agents will not tolerate the GPU taint."
  }
}

variable "gpu_worker_count" {
  description = <<-EOT
    Workers that will be labelled and tainted as the accelerator pool.

    These have no GPU. They cannot have one — see docs/apple-silicon-reality.md.
    They exist so that scheduling against a tainted, specially-resourced pool is
    a real thing you can break and fix, which is the part that transfers.
  EOT
  type        = number
  default     = 1
}

variable "http_node_port" {
  description = "Host port mapped to the ingress NodePort. Labs 50 and 60 publish gateways here."
  type        = number
  default     = 8080
}

variable "https_node_port" {
  type    = number
  default = 8443
}
