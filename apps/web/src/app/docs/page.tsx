'use client';

import { useState, useEffect } from 'react';
import { FileText, Plus } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { CategoryCard } from '@/components/docs/category-card';
import { ArticleList } from '@/components/docs/article-list';
import { LoomImport } from '@/components/docs/loom-import';
import { cn } from '@/lib/utils';

interface DocCategory {
    id: string;
    name: string;
    description: string | null;
    articleCount: number;
    createdAt: string;
}

interface DocArticle {
    id: string;
    title: string;
    content: string;
    status: 'DRAFT' | 'PUBLISHED';
    sourceUrl?: string | null;
    categoryId: string;
    category?: { id: string; name: string };
    createdAt: string;
    updatedAt: string;
}

type Tab = 'ai-drafts' | 'published';

export default function DocsPage() {
    const [activeTab, setActiveTab] = useState<Tab>('published');
    const [categories, setCategories] = useState<DocCategory[]>([]);
    const [articles, setArticles] = useState<DocArticle[]>([]);
    const [total, setTotal] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchData() {
            try {
                const [catRes, artRes] = await Promise.all([
                    fetch('/api/docs/categories'),
                    fetch('/api/docs/articles?pageSize=100'),
                ]);
                if (catRes.ok) {
                    const catData = await catRes.json();
                    setCategories(catData.categories);
                }
                if (artRes.ok) {
                    const artData = await artRes.json();
                    setArticles(artData.articles);
                    setTotal(typeof artData.total === 'number' ? artData.total : null);
                }
            } finally {
                setLoading(false);
            }
        }
        fetchData();
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <p className="text-muted-foreground">Loading...</p>
            </div>
        );
    }

    const aiDrafts = articles.filter(a => a.status === 'DRAFT' && a.sourceUrl);
    const published = articles.filter(a => a.status === 'PUBLISHED');

    return (
        <div>
            <PageHeader
                title="Documentation"
                description="Knowledge base articles and documentation management."
                icon={FileText}
                breadcrumbs={[{ label: 'Docs' }]}
            />

            {/* Loom Import */}
            <div className="mb-8">
                <LoomImport />
            </div>

            {/* Categories Grid */}
            <div className="mb-8">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-foreground">Categories</h2>
                    <button className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                        <Plus className="h-3.5 w-3.5" />
                        Create New
                    </button>
                </div>
                {categories.length === 0 ? (
                    <div className="rounded-lg border border-border bg-card p-8 text-center">
                        <p className="text-muted-foreground">No categories yet.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                        {categories.map((category) => (
                            <CategoryCard key={category.id} category={category} />
                        ))}
                    </div>
                )}
            </div>

            {/* Tabs */}
            <div className="mb-6">
                <div className="flex items-center gap-1 border-b border-border">
                    <button
                        onClick={() => setActiveTab('ai-drafts')}
                        className={cn(
                            'px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
                            activeTab === 'ai-drafts'
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground',
                        )}
                    >
                        AI Drafts
                        <span className="ml-2 inline-flex items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs">
                            {aiDrafts.length}
                        </span>
                    </button>
                    <button
                        onClick={() => setActiveTab('published')}
                        className={cn(
                            'px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
                            activeTab === 'published'
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground',
                        )}
                    >
                        Published
                        <span className="ml-2 inline-flex items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs">
                            {published.length}
                        </span>
                    </button>
                </div>
            </div>

            {/* Tab Content */}
            <ArticleList
                articles={activeTab === 'ai-drafts' ? aiDrafts : published}
                categoryId=""
            />
            {total !== null && total > articles.length && (
                <p className="mt-4 text-sm text-muted-foreground">
                    Showing {articles.length} of {total} articles. Server-side status
                    filtering with per-section pagination is a follow-up.
                </p>
            )}
        </div>
    );
}
