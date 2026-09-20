variable "cluster_name" {
  description = "kind cluster name. Node container names derive from it."
  type        = string
  default     = "a2a-lab"
}

variable "node_image" {
  description = "kind node image, which pins the Kubernetes version."
  type        = string
  default     = "kindest/node:v1.36.1"
}

variable "cpu_worker_count" {
  description = "Workers in the general-purpose node group."
  type        = number
  default     = 2

  validation {
    condition     = var.cpu_worker_count >= 1
    error_message = "At least one CPU worker: nothing else tolerates the GPU taint."
  }
}

variable "gpu_worker_count" {
  description = <<-EOT
    Workers in the accelerator node group.

    This is the Mac (Apple Silicon) variant of the lab: there is **no GPU node
    group**, so this defaults to 0. A MacBook's GPU is not a CUDA device kind
    can inject the way the Windows/WSL2 lab does, so the accelerator node group
    is left out entirely rather than faked. Lab 30 here teaches CPU node-pool
    scheduling (labels + taints), which ports to any EKS node group unchanged.
  EOT
  type    = number
  default = 0

  validation {
    condition     = var.gpu_worker_count == 0 || var.enable_gpu == false
    error_message = "The Mac lab has no GPU node group. Keep gpu_worker_count = 0."
  }
}

variable "enable_gpu" {
  description = <<-EOT
    GPU injection. Always false on the Mac variant — there is no CUDA device to
    inject. Kept only so main.tf stays identical to the Windows lab (one code
    path), and so the node-group *shape* can still be created with an extra
    worker if you ever set gpu_worker_count > 0 for scheduling experiments.
  EOT
  type    = bool
  default = false
}

variable "zones" {
  description = <<-EOT
    Fake availability zones, spread across the CPU workers.

    The values are fictional; the label key topology.kubernetes.io/zone is the
    real one EKS uses, so topologySpreadConstraints written here work on EKS
    unchanged — and actually mean something locally, which they would not on a
    single-zone cluster.
  EOT
  type    = list(string)
  default = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
}

variable "cpu_instance_type" {
  description = "What the CPU nodes claim to be. Fictional value, real label key."
  type        = string
  default     = "m6i.large"
}

variable "gpu_instance_type" {
  type    = string
  default = "g5.xlarge"
}

variable "http_node_port" {
  description = "Host port mapped to the ingress NodePort."
  type        = number
  default     = 8080
}

variable "https_node_port" {
  type    = number
  default = 8443
}

variable "agentgateway_node_port" {
  description = "Second ingress, so lab 50 and lab 60 can run side by side and be compared."
  type        = number
  default     = 8081
}
